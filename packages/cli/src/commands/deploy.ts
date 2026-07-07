import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TURBOTUNNEL_VERSION } from "@turbotunnel/protocol";
import { Effect, Option, Redacted, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { readLocalConfig } from "../config.js";
import {
  domainToAdd,
  type DeployCommandOptions,
  type DeployPlan,
  makeDeployPlan,
} from "../deploy-plan.js";
import {
  CliConfigError,
  ConfigFileParseError,
  ConfigFileReadError,
  DeploymentGenerationFailed,
  DeploymentVerificationFailed,
  DeployOutputParseError,
  VercelCommandFailed,
  VercelCommandNotFound,
} from "../errors.js";
import { bold, formatRows, url, writeHuman, writeMachineJson } from "../output.js";
import { runCommand } from "../process.js";

export type DeployOutputFormat = "human" | "json";

type DeployedGateway = DeployPlan & {
  readonly deploymentUrl: string;
};

type DeployError =
  | CliConfigError
  | ConfigFileParseError
  | ConfigFileReadError
  | DeploymentGenerationFailed
  | DeploymentVerificationFailed
  | DeployOutputParseError
  | VercelCommandFailed
  | VercelCommandNotFound;

const GATEWAY_VERIFICATION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const VERCEL_CLI_MISSING_MESSAGE =
  "Vercel CLI is required to deploy Turbotunnel, but no `vercel` executable was found in PATH. Install it with `bun add --global vercel` or `npm install --global vercel`, then run `vercel login` and retry `tt deploy`. No gateway was deployed and your local tunnel config was not changed.";

const GatewayStatusJsonSchema = Schema.Struct({
  status: Schema.Literals(["running"]),
  version: Schema.String,
  baseDomain: Schema.String,
  broker: Schema.String,
  queueRegion: Schema.String,
});

type GatewayStatusJson = typeof GatewayStatusJsonSchema.Type;

export const deployGateway = Effect.fn("deployGateway")(function* (
  options: DeployCommandOptions & { readonly format: DeployOutputFormat },
): Effect.fn.Return<DeployedGateway, DeployError, ChildProcessSpawner | FileSystem> {
  const savedConfig = yield* readLocalConfig();
  const planResult = makeDeployPlan(options, {
    project: savedConfig.project,
    slug: savedConfig.slug,
    relayDomain: savedConfig.relayDomain,
    relaySecret: savedConfig.relaySecret,
    queueRegion: savedConfig.queueRegion,
  });
  if (planResult._tag === "err") {
    return yield* planResult.error;
  }

  const plan = planResult.value;

  yield* runCommand("vercel", ["--version"], undefined, {
    commandNotFoundMessage: VERCEL_CLI_MISSING_MESSAGE,
  });
  const account = yield* runCommand("vercel", ["whoami"], undefined, {
    output: "capture",
    failureMessage:
      "Vercel CLI is installed, but `vercel whoami` failed. Run `vercel login`, confirm the account has access to create projects, then retry `tt deploy`. No gateway was deployed and your local tunnel config was not changed.",
  });

  if (options.format === "human") {
    yield* printDeployPreview(plan, account.stdout.trim());
  }

  yield* writeHuman("Generating gateway files…");
  yield* generateGatewayDeployment(plan.deployDir);
  yield* writeHuman("Linking Vercel project…");
  yield* runCommand("vercel", ["link", "--yes", "--project", plan.project], plan.deployDir);
  yield* writeHuman("Setting gateway Environment Variables…");
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_BASE_DOMAIN", plan.baseDomain);
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_RELAY_SECRET", Redacted.value(plan.relaySecret));
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_QUEUE_REGION", plan.queueRegion);

  if (!plan.publicHost.endsWith(".vercel.app")) {
    yield* writeHuman("Adding gateway domain…");
    yield* runCommand(
      "vercel",
      ["domains", "add", domainToAdd(plan.baseDomain, plan.slug), plan.project],
      plan.deployDir,
      {
        includeOutputOnFailure: true,
        failureMessage:
          "Failed to add the gateway domain. No gateway was deployed and your local tunnel config was not changed. Review the Vercel output below, fix domain ownership or DNS, then run `tt deploy` again.",
      },
    );
  }

  yield* writeHuman("Deploying gateway…");
  const deployOutput = yield* runCommand("vercel", ["deploy", "--prod", "--yes"], plan.deployDir, {
    output: "capture",
    includeOutputOnFailure: true,
    failureMessage:
      "Vercel deployment failed before local config was updated. Your previous Turbotunnel config is still intact. Review the Vercel output below, then retry `tt deploy`.",
  });
  const deploymentUrl = yield* parseDeploymentUrl(deployOutput.stdout);
  yield* writeHuman("Verifying gateway…");
  yield* verifyGatewayDeployment(plan);
  yield* writeLocalConfig(plan);
  yield* printDeploymentSummary(plan, deploymentUrl, options.format);

  return { ...plan, deploymentUrl };
});

const generateGatewayDeployment = Effect.fn("generateGatewayDeployment")(function* (
  deployDir: string,
): Effect.fn.Return<void, DeploymentGenerationFailed, FileSystem> {
  const fs = yield* FileSystem;
  const source = yield* resolveGatewayDeploymentSource();
  yield* cleanGeneratedDeploymentDirectory(deployDir);
  yield* fs.makeDirectory(deployDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DeploymentGenerationFailed({
          operation: "create generated gateway directory",
          path: deployDir,
          cause,
          message: `Failed to create the generated gateway directory at ${deployDir}. No gateway was deployed and your local tunnel config was not changed.`,
        }),
    ),
  );
  yield* writeGeneratedPackageJson(deployDir, TURBOTUNNEL_VERSION);
  yield* copyFileFromTemplate(source.templateDir, deployDir, "api/server.ts", (text) =>
    text.replace('from "@turbotunnel/gateway"', 'from "../src/gateway/index.js"'),
  );
  yield* writeGeneratedTsconfig(deployDir);
  yield* copyFileFromTemplate(source.templateDir, deployDir, "vercel.json");
  yield* copyDirectory(source.protocolSrcDir, join(deployDir, "src", "protocol"));
  yield* copyDirectory(source.gatewaySrcDir, join(deployDir, "src", "gateway"), (text) =>
    text.replaceAll('from "@turbotunnel/protocol"', 'from "../protocol/index.js"'),
  );
  yield* assertGeneratedDeploymentIsStandalone(deployDir);
});

function cleanGeneratedDeploymentDirectory(
  deployDir: string,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* assertDeploymentDirectoryIsNotSymlink(deployDir);
    const exists = yield* fs.exists(deployDir).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "check generated gateway directory",
            path: deployDir,
            cause,
            message: `Failed to check the generated gateway directory at ${deployDir}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    if (!exists) {
      return;
    }

    const entries = yield* fs.readDirectory(deployDir).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "read generated gateway directory",
            path: deployDir,
            cause,
            message: `Failed to read the generated gateway directory at ${deployDir}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    for (const entry of entries) {
      if (entry === ".vercel") {
        continue;
      }

      const path = join(deployDir, entry);
      yield* fs.remove(path, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "remove stale generated gateway path",
              path,
              cause,
              message: `Failed to remove stale generated gateway path at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
    }
  });
}

function assertDeploymentDirectoryIsNotSymlink(
  deployDir: string,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const linkTarget = yield* fs.readLink(deployDir).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed(Option.none<string>());
        }

        return Effect.succeed(Option.none<string>());
      }),
    );

    if (linkTarget._tag === "None") {
      return;
    }

    return yield* new DeploymentGenerationFailed({
      operation: "check generated gateway directory symlink",
      path: deployDir,
      cause: { linkTarget: linkTarget.value },
      message: `Refusing to clean generated gateway directory at ${deployDir} because it is a symbolic link. Replace it with a real directory, then run \`tt deploy\` again. No gateway was deployed and your local tunnel config was not changed.`,
    });
  });
}

type GatewayDeploymentSource = {
  readonly templateDir: string;
  readonly gatewaySrcDir: string;
  readonly protocolSrcDir: string;
};

function resolveGatewayDeploymentSource(): Effect.Effect<
  GatewayDeploymentSource,
  DeploymentGenerationFailed,
  FileSystem
> {
  return Effect.gen(function* () {
    const here = dirname(fileURLToPath(import.meta.url));
    const packagedCandidates = [
      resolve(here, "..", "gateway-template"),
      resolve(here, "..", "..", "gateway-template"),
    ];

    for (const candidate of packagedCandidates) {
      if (yield* directoryExists(candidate)) {
        return {
          templateDir: candidate,
          gatewaySrcDir: join(candidate, "src", "gateway"),
          protocolSrcDir: join(candidate, "src", "protocol"),
        };
      }
    }

    const repoRoot = resolve(here, "../../../../");
    return {
      templateDir: join(repoRoot, "packages", "gateway", "vercel"),
      gatewaySrcDir: join(repoRoot, "packages", "gateway", "src"),
      protocolSrcDir: join(repoRoot, "packages", "protocol", "src"),
    };
  });
}

function directoryExists(
  path: string,
): Effect.Effect<boolean, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;

    return yield* fs.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catchTag("PlatformError", (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed(false);
        }

        return Effect.fail(
          new DeploymentGenerationFailed({
            operation: "stat deployment source directory",
            path,
            cause,
            message: `Failed to inspect the deployment source directory at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
        );
      }),
    );
  });
}

function copyFileFromTemplate(
  templateDir: string,
  deployDir: string,
  relativePath: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  const source = join(templateDir, relativePath);
  const target = join(deployDir, relativePath);
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "create generated file parent",
            path: dirname(target),
            cause,
            message: `Failed to create the generated file parent at ${dirname(target)}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    const text = yield* fs.readFileString(source, "utf8").pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "read gateway template file",
            path: source,
            cause,
            message: `Failed to read the gateway template file at ${source}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    yield* fs.writeFileString(target, transform(text)).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "write generated gateway file",
            path: target,
            cause,
            message: `Failed to write the generated gateway file at ${target}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
  });
}

function copyDirectory(
  source: string,
  target: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(target, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "create generated directory",
            path: target,
            cause,
            message: `Failed to create the generated directory at ${target}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    const entries = yield* fs.readDirectory(source).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "read source directory",
            path: source,
            cause,
            message: `Failed to read the source directory at ${source}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
        continue;
      }

      const sourcePath = join(source, entry);
      const targetPath = join(target, entry);
      const stats = yield* fs.stat(sourcePath).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "stat source path",
              path: sourcePath,
              cause,
              message: `Failed to inspect the source path at ${sourcePath}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
      if (stats.type === "Directory") {
        yield* copyDirectory(sourcePath, targetPath, transform);
        continue;
      }

      yield* fs.makeDirectory(dirname(targetPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "create generated file parent",
              path: dirname(targetPath),
              cause,
              message: `Failed to create the generated file parent at ${dirname(targetPath)}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
      if (sourcePath.endsWith(".ts")) {
        const text = yield* fs.readFileString(sourcePath, "utf8").pipe(
          Effect.mapError(
            (cause) =>
              new DeploymentGenerationFailed({
                operation: "read source TypeScript file",
                path: sourcePath,
                cause,
                message: `Failed to read the source TypeScript file at ${sourcePath}. No gateway was deployed and your local tunnel config was not changed.`,
              }),
          ),
        );
        yield* fs.writeFileString(targetPath, transform(text)).pipe(
          Effect.mapError(
            (cause) =>
              new DeploymentGenerationFailed({
                operation: "write generated TypeScript file",
                path: targetPath,
                cause,
                message: `Failed to write the generated TypeScript file at ${targetPath}. No gateway was deployed and your local tunnel config was not changed.`,
              }),
          ),
        );
        continue;
      }

      const bytes = yield* fs.readFile(sourcePath).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "read source file",
              path: sourcePath,
              cause,
              message: `Failed to read the source file at ${sourcePath}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
      yield* fs.writeFile(targetPath, bytes).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "write generated file",
              path: targetPath,
              cause,
              message: `Failed to write the generated file at ${targetPath}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
    }
  });
}

function writeGeneratedPackageJson(
  deployDir: string,
  version: string,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  const path = join(deployDir, "package.json");
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs
      .writeFileString(
        path,
        `${JSON.stringify(
          {
            name: "turbotunnel-gateway-deployment",
            version,
            private: true,
            type: "module",
            dependencies: {
              effect: "4.0.0-beta.92",
              nanoid: "^5.1.6",
              ws: "^8.18.3",
            },
            devDependencies: {
              "@types/node": "^22.15.3",
              "@types/ws": "^8.18.1",
              typescript: "6.0.3",
            },
          },
          null,
          2,
        )}\n`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "write generated package.json",
              path,
              cause,
              message: `Failed to write generated package.json at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
  });
}

function writeGeneratedTsconfig(
  deployDir: string,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  const path = join(deployDir, "tsconfig.json");
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs
      .writeFileString(
        path,
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              lib: ["ES2022"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              strictNullChecks: true,
              esModuleInterop: true,
              skipLibCheck: true,
              forceConsistentCasingInFileNames: true,
            },
            include: ["api", "src"],
          },
          null,
          2,
        )}\n`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "write generated tsconfig.json",
              path,
              cause,
              message: `Failed to write generated tsconfig.json at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
  });
}

const assertGeneratedDeploymentIsStandalone = Effect.fn("assertGeneratedDeploymentIsStandalone")(
  function* (deployDir: string): Effect.fn.Return<void, DeploymentGenerationFailed, FileSystem> {
    const offendingFiles = yield* filesContainingAny(deployDir, [
      "@turbotunnel/gateway",
      "@turbotunnel/protocol",
      "@turbotunnel/typescript-config",
    ]);

    if (offendingFiles.length > 0) {
      return yield* new DeploymentGenerationFailed({
        operation: "assert generated deployment standalone",
        path: deployDir,
        cause: offendingFiles,
        message: `Generated gateway deployment still contains workspace-only imports in ${offendingFiles.join(
          ", ",
        )}. No gateway was deployed.`,
      });
    }
  },
);

function filesContainingAny(
  directory: string,
  needles: ReadonlyArray<string>,
): Effect.Effect<Array<string>, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const matches: Array<string> = [];
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "read generated deployment directory",
            path: directory,
            cause,
            message: `Failed to read the generated deployment directory at ${directory}. No gateway was deployed and your local tunnel config was not changed.`,
          }),
      ),
    );
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".vercel") {
        continue;
      }

      const path = join(directory, entry);
      const stats = yield* fs.stat(path).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "stat generated deployment path",
              path,
              cause,
              message: `Failed to inspect the generated deployment path at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
      if (stats.type === "Directory") {
        matches.push(...(yield* filesContainingAny(path, needles)));
        continue;
      }

      if (!path.endsWith(".ts") && !path.endsWith(".json")) {
        continue;
      }

      const text = yield* fs.readFileString(path, "utf8").pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "read generated deployment file",
              path,
              cause,
              message: `Failed to read the generated deployment file at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
            }),
        ),
      );
      if (needles.some((needle) => text.includes(needle))) {
        matches.push(path);
      }
    }

    return matches;
  });
}

function setVercelEnv(
  cwd: string,
  name: string,
  value: string,
): Effect.Effect<void, VercelCommandFailed | VercelCommandNotFound, ChildProcessSpawner> {
  return Effect.gen(function* () {
    const update = yield* runCommand("vercel", ["env", "update", name, "production"], cwd, {
      stdin: `${value}\n`,
      allowFailure: true,
      output: "capture",
    });
    if (update.exitCode === 0) {
      return;
    }

    yield* runCommand("vercel", ["env", "add", name, "production"], cwd, {
      stdin: `${value}\n`,
      failureMessage: `Failed to set ${name} for the Production environment. No local tunnel config was changed. Open the Vercel project Environment Variables, fix the value, then run \`tt deploy\` again.`,
    });
  });
}

function writeLocalConfig(
  plan: DeployPlan,
): Effect.Effect<void, DeploymentGenerationFailed, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(dirname(plan.configPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentGenerationFailed({
            operation: "create local config directory",
            path: dirname(plan.configPath),
            cause,
            message: `Gateway was deployed at https://${plan.publicHost}/, but Turbotunnel could not create the local config directory at ${dirname(plan.configPath)}. Fix local file permissions, then run \`tt deploy\` again to save the config.`,
          }),
      ),
    );
    yield* fs
      .writeFileString(
        plan.configPath,
        `${JSON.stringify(
          {
            project: plan.project,
            slug: plan.slug,
            relayDomain: plan.baseDomain,
            queueRegion: plan.queueRegion,
            relaySecret: Redacted.value(plan.relaySecret),
          },
          null,
          2,
        )}\n`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentGenerationFailed({
              operation: "write local tunnel config",
              path: plan.configPath,
              cause,
              message: `Gateway was deployed at https://${plan.publicHost}/, but Turbotunnel could not write the local config at ${plan.configPath}. Fix local file permissions, then run \`tt deploy\` again to save the config.`,
            }),
        ),
      );
  });
}

function parseDeploymentUrl(stdout: string): Effect.Effect<string, DeployOutputParseError> {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const url =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    if (URL.canParse(url)) {
      return Effect.succeed(url.endsWith("/") ? url : `${url}/`);
    }
  }

  return new DeployOutputParseError({
    stdout,
    message:
      "Vercel deployment completed, but Turbotunnel could not read the deployment URL from Vercel output. Local config was not changed. Retry `tt deploy`; if this continues, run `vercel deploy --prod --yes` in ~/.turbotunnel/relay and inspect stdout.",
  });
}

function verifyGatewayDeployment(
  plan: DeployPlan,
): Effect.Effect<void, DeploymentVerificationFailed> {
  return Effect.gen(function* () {
    const gatewayUrl = `https://${plan.publicHost}/`;
    let latestError: DeploymentVerificationFailed | undefined;

    for (let attempt = 0; attempt <= GATEWAY_VERIFICATION_RETRY_DELAYS_MS.length; attempt += 1) {
      const error = yield* verifyGatewayStatus(plan, gatewayUrl).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error)),
      );
      if (error === undefined) {
        return;
      }

      latestError = error;
      const retryDelayMs = GATEWAY_VERIFICATION_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs !== undefined) {
        yield* Effect.sleep(retryDelayMs);
      }
    }

    return yield* (
      latestError ??
        new DeploymentVerificationFailed({
          reason: "unknown",
          url: gatewayUrl,
          message:
            "Deployment was created, but Turbotunnel could not verify the public gateway URL. Your previous Turbotunnel config is still intact. Retry `tt deploy`, or open the Vercel deployment logs if this continues.",
        })
    );
  });
}

function verifyGatewayStatus(
  plan: DeployPlan,
  baseUrl: string,
): Effect.Effect<void, DeploymentVerificationFailed> {
  return Effect.gen(function* () {
    const statusUrl = new URL("/_turbotunnel/status", baseUrl).toString();
    const verified = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await globalThis.fetch(statusUrl, {
          headers: { accept: "application/json" },
          signal,
        });
        const body = await response.text();
        return { response, body };
      },
      catch: (cause) =>
        new DeploymentVerificationFailed({
          reason: "request-failed",
          url: statusUrl,
          cause,
          message:
            "Deployment was created, but Turbotunnel could not reach the gateway status endpoint. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: 15_000,
        orElse: () =>
          Effect.fail(
            new DeploymentVerificationFailed({
              reason: "timeout",
              url: statusUrl,
              message:
                "Deployment was created, but the gateway status endpoint did not respond within 15 seconds. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
            }),
          ),
      }),
    );

    if (verified.response.status !== 200) {
      return yield* new DeploymentVerificationFailed({
        reason: "bad-status",
        url: statusUrl,
        status: verified.response.status,
        message: `Deployment was created, but the public gateway URL returned HTTP ${verified.response.status} during verification. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact. Retry \`tt deploy\`, or open the Vercel deployment logs if this continues.`,
      });
    }

    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(verified.body),
      catch: (cause) =>
        new DeploymentVerificationFailed({
          reason: "body-mismatch",
          url: statusUrl,
          cause,
          bodyExcerpt: statusBodyExcerpt(verified.body),
          message: `Deployment was created, but the gateway status endpoint did not return JSON. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact. Open the Vercel deployment logs if this continues.`,
        }),
    });
    const status = yield* Schema.decodeUnknownEffect(GatewayStatusJsonSchema)(json).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentVerificationFailed({
            reason: "body-mismatch",
            url: statusUrl,
            cause,
            bodyExcerpt: statusBodyExcerpt(verified.body),
            message: `Deployment was created, but the gateway status JSON had an unsupported shape. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact. Open the Vercel deployment logs if this continues.`,
          }),
      ),
    );

    yield* assertGatewayStatusField(statusUrl, "version", status.version, TURBOTUNNEL_VERSION);
    yield* assertGatewayStatusField(statusUrl, "baseDomain", status.baseDomain, plan.baseDomain);
    yield* assertGatewayStatusField(statusUrl, "queueRegion", status.queueRegion, plan.queueRegion);
  });
}

function assertGatewayStatusField(
  statusUrl: string,
  field: keyof GatewayStatusJson,
  actual: string,
  expected: string,
): Effect.Effect<void, DeploymentVerificationFailed> {
  if (actual === expected) {
    return Effect.void;
  }

  return new DeploymentVerificationFailed({
    reason: "body-mismatch",
    url: statusUrl,
    missingLine: `${field}: ${expected}`,
    bodyExcerpt: `${field}: ${actual}`,
    message: `Deployment was created, but the gateway status JSON did not match the expected ${field}. Expected ${expected}, received ${actual}. Your previous Turbotunnel config is still intact. Open the Vercel deployment logs if this continues.`,
  });
}

function statusBodyExcerpt(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine === undefined) {
    return "empty response body";
  }

  if (firstLine.length <= 160) {
    return firstLine;
  }

  return `${firstLine.slice(0, 160)}…`;
}

function printDeployPreview(plan: DeployPlan, account: string): Effect.Effect<void> {
  const gatewayUrl = `https://${plan.publicHost}/`;
  const rows = [
    ...(account.length > 0 ? [{ label: "Vercel", value: account }] : []),
    { label: "Project", value: plan.project },
    { label: "Gateway", value: url(gatewayUrl) },
    { label: "Tunnel domain", value: plan.baseDomain },
    { label: "Queue region", value: plan.queueRegion },
    { label: "Config", value: plan.configPath },
  ];
  const heading = plan.reusedSavedTarget
    ? "Redeploying Turbotunnel gateway"
    : "Deploying Turbotunnel gateway";
  return writeHuman(`\n${bold(heading)}\n\n${formatRows(rows)}\n`);
}

function printDeploymentSummary(
  plan: DeployPlan,
  deploymentUrl: string,
  format: DeployOutputFormat,
): Effect.Effect<void> {
  const gatewayUrl = `https://${plan.publicHost}/`;
  if (format === "json") {
    return writeMachineJson({
      status: "success",
      reason: "gateway_deployed",
      data: {
        gatewayUrl,
        deploymentUrl,
        project: plan.project,
        tunnelDomain: plan.baseDomain,
        queueRegion: plan.queueRegion,
        configPath: plan.configPath,
      },
      next: [{ command: "tt http 5173", argv: ["tt", "http", "5173"] }],
    });
  }

  return writeHuman(
    `\n${formatRows([
      { glyph: "✓", label: "Gateway", value: "deployed" },
      { label: "Gateway", value: url(gatewayUrl) },
      ...(deploymentUrl === gatewayUrl ? [] : [{ label: "Deployment", value: url(deploymentUrl) }]),
      { label: "Tunnel domain", value: plan.baseDomain },
      { label: "Queue region", value: plan.queueRegion },
      { label: "Config", value: plan.configPath },
      { label: "Next", value: "tt http 5173" },
    ])}\n`,
  );
}
