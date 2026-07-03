import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import kleur from "kleur";
import { Console, Effect, Redacted } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { customAlphabet } from "nanoid";

import {
  CliConfigError,
  DeploymentGenerationFailed,
  VercelCommandFailed,
  VercelCommandNotFound,
} from "../errors.js";
import { runCommand } from "../process.js";

export type DeployCommandOptions = {
  readonly project?: string;
  readonly domain?: string;
  readonly region: string;
};

type DeployPlan = {
  readonly slug: string;
  readonly project: string;
  readonly baseDomain: string;
  readonly publicHost: string;
  readonly queueRegion: string;
  readonly relaySecret: Redacted.Redacted<string>;
  readonly deployDir: string;
};

type DeployError =
  | CliConfigError
  | DeploymentGenerationFailed
  | VercelCommandFailed
  | VercelCommandNotFound;

const cleanSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const PROJECT_SUFFIX = "-turbotunnel";
const VERCEL_CLI_MISSING_MESSAGE =
  "Vercel CLI is required to deploy Turbotunnel, but no `vercel` executable was found in PATH. Install it with `bun add --global vercel` or `npm install --global vercel`, then run `vercel login` and retry `bun run tt -- deploy`. No gateway was deployed and your local tunnel config was not changed.";

export const deployGateway = Effect.fn("deployGateway")(function* (
  options: DeployCommandOptions,
): Effect.fn.Return<DeployPlan, DeployError, ChildProcessSpawner> {
  const plan = yield* makeDeployPlan(options);

  yield* runCommand("vercel", ["--version"], undefined, {
    commandNotFoundMessage: VERCEL_CLI_MISSING_MESSAGE,
  });
  yield* runCommand("vercel", ["whoami"], undefined, {
    failureMessage:
      "Vercel CLI is installed, but `vercel whoami` failed. Run `vercel login`, confirm the account has access to create projects, then retry `bun run tt -- deploy`. No gateway was deployed and your local tunnel config was not changed.",
  });
  yield* generateGatewayDeployment(plan.deployDir);
  yield* runCommand("vercel", ["link", "--yes", "--project", plan.project], plan.deployDir);
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_BASE_DOMAIN", plan.baseDomain);
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_RELAY_SECRET", Redacted.value(plan.relaySecret));
  yield* setVercelEnv(plan.deployDir, "TURBOTUNNEL_QUEUE_REGION", plan.queueRegion);

  if (!plan.publicHost.endsWith(".vercel.app")) {
    yield* runCommand(
      "vercel",
      ["domains", "add", domainToAdd(plan.baseDomain, plan.slug)],
      plan.deployDir,
    );
  }

  yield* runCommand("vercel", ["deploy", "--prod", "--yes"], plan.deployDir);
  yield* writeLocalConfig(plan);

  yield* Console.log(kleur.green(`Gateway deployed at https://${plan.publicHost}/`));
  return plan;
});

function makeDeployPlan(options: DeployCommandOptions): Effect.Effect<DeployPlan, CliConfigError> {
  const slugResult = resolveDeploySlug(options);
  if (slugResult._tag === "err") {
    return slugResult.error;
  }

  const slug = slugResult.value;
  const project = options.project ?? `${slug}${PROJECT_SUFFIX}`;
  const baseDomain = options.domain ?? "{slug}-turbotunnel.vercel.app";
  const publicHost = baseDomain.replaceAll("{slug}", slug);
  const queueRegion = options.region;
  const relaySecret = Redacted.make(`ttsec_${randomBytes(24).toString("base64url")}`, {
    label: "relay-secret",
  });
  const deployDir = join(homedir(), ".turbotunnel", "relay");

  return Effect.succeed({
    slug,
    project,
    baseDomain,
    publicHost,
    queueRegion,
    relaySecret,
    deployDir,
  });
}

function resolveDeploySlug(
  options: DeployCommandOptions,
):
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (options.project === undefined) {
    return { _tag: "ok", value: `tt${cleanSlug()}` };
  }

  if (options.project.endsWith(PROJECT_SUFFIX)) {
    const slug = options.project.slice(0, -PROJECT_SUFFIX.length);
    if (slug.length > 0) {
      return { _tag: "ok", value: slug };
    }
  }

  if (options.domain !== undefined) {
    return { _tag: "ok", value: `tt${cleanSlug()}` };
  }

  return {
    _tag: "err",
    error: new CliConfigError({
      message: "--project without --domain must use the <slug>-turbotunnel format.",
    }),
  };
}

function domainToAdd(baseDomain: string, slug: string): string {
  if (baseDomain.includes("{slug}")) {
    return baseDomain.replaceAll("{slug}", slug);
  }

  return `*.${baseDomain}`;
}

const generateGatewayDeployment = Effect.fn("generateGatewayDeployment")(function* (
  deployDir: string,
): Effect.fn.Return<void, DeploymentGenerationFailed, never> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
  const templateDir = join(repoRoot, "packages", "gateway", "vercel");
  yield* fsOperation("remove generated gateway directory", deployDir, () =>
    rm(deployDir, { recursive: true, force: true }),
  );
  yield* fsOperation("create generated gateway directory", deployDir, () =>
    mkdir(deployDir, { recursive: true }),
  );
  yield* writeGeneratedPackageJson(deployDir);
  yield* copyFileFromTemplate(templateDir, deployDir, "api/server.ts", (text) =>
    text.replace('from "@repo/gateway"', 'from "../src/gateway/index.js"'),
  );
  yield* writeGeneratedTsconfig(deployDir);
  yield* copyFileFromTemplate(templateDir, deployDir, "vercel.json");
  yield* copyDirectory(
    join(repoRoot, "packages", "protocol", "src"),
    join(deployDir, "src", "protocol"),
  );
  yield* copyDirectory(
    join(repoRoot, "packages", "gateway", "src"),
    join(deployDir, "src", "gateway"),
    (text) => text.replaceAll('from "@repo/turbotunnel-protocol"', 'from "../protocol/index.js"'),
  );
  yield* assertGeneratedDeploymentIsStandalone(deployDir);
});

function copyFileFromTemplate(
  templateDir: string,
  deployDir: string,
  relativePath: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, DeploymentGenerationFailed> {
  const source = join(templateDir, relativePath);
  const target = join(deployDir, relativePath);
  return Effect.gen(function* () {
    yield* fsOperation("create generated file parent", dirname(target), () =>
      mkdir(dirname(target), { recursive: true }),
    );
    const text = yield* fsOperation("read gateway template file", source, () =>
      readFile(source, "utf8"),
    );
    yield* fsOperation("write generated gateway file", target, () =>
      writeFile(target, transform(text)),
    );
  });
}

function copyDirectory(
  source: string,
  target: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, DeploymentGenerationFailed> {
  return Effect.gen(function* () {
    yield* fsOperation("create generated directory", target, () =>
      mkdir(target, { recursive: true }),
    );
    const entries = yield* fsOperation("read source directory", source, () => readdir(source));
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
        continue;
      }

      const sourcePath = join(source, entry);
      const targetPath = join(target, entry);
      const stats = yield* fsOperation("stat source path", sourcePath, () => stat(sourcePath));
      if (stats.isDirectory()) {
        yield* copyDirectory(sourcePath, targetPath, transform);
        continue;
      }

      yield* fsOperation("create generated file parent", dirname(targetPath), () =>
        mkdir(dirname(targetPath), { recursive: true }),
      );
      if (sourcePath.endsWith(".ts")) {
        const text = yield* fsOperation("read source TypeScript file", sourcePath, () =>
          readFile(sourcePath, "utf8"),
        );
        yield* fsOperation("write generated TypeScript file", targetPath, () =>
          writeFile(targetPath, transform(text)),
        );
        continue;
      }

      const bytes = yield* fsOperation("read source file", sourcePath, () => readFile(sourcePath));
      yield* fsOperation("write generated file", targetPath, () => writeFile(targetPath, bytes));
    }
  });
}

function writeGeneratedPackageJson(
  deployDir: string,
): Effect.Effect<void, DeploymentGenerationFailed> {
  return fsOperation("write generated package.json", join(deployDir, "package.json"), () =>
    writeFile(
      join(deployDir, "package.json"),
      `${JSON.stringify(
        {
          name: "turbotunnel-gateway-deployment",
          version: "0.0.0",
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
            typescript: "5.9.2",
          },
        },
        null,
        2,
      )}\n`,
    ),
  );
}

function writeGeneratedTsconfig(
  deployDir: string,
): Effect.Effect<void, DeploymentGenerationFailed> {
  return fsOperation("write generated tsconfig.json", join(deployDir, "tsconfig.json"), () =>
    writeFile(
      join(deployDir, "tsconfig.json"),
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
    ),
  );
}

const assertGeneratedDeploymentIsStandalone = Effect.fn("assertGeneratedDeploymentIsStandalone")(
  function* (deployDir: string): Effect.fn.Return<void, DeploymentGenerationFailed, never> {
    const offendingFiles = yield* filesContainingAny(deployDir, [
      "@repo/gateway",
      "@repo/turbotunnel-protocol",
      "@repo/typescript-config",
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
): Effect.Effect<Array<string>, DeploymentGenerationFailed> {
  return Effect.gen(function* () {
    const matches: Array<string> = [];
    const entries = yield* fsOperation("read generated deployment directory", directory, () =>
      readdir(directory),
    );
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".vercel") {
        continue;
      }

      const path = join(directory, entry);
      const stats = yield* fsOperation("stat generated deployment path", path, () => stat(path));
      if (stats.isDirectory()) {
        matches.push(...(yield* filesContainingAny(path, needles)));
        continue;
      }

      if (!path.endsWith(".ts") && !path.endsWith(".json")) {
        continue;
      }

      const text = yield* fsOperation("read generated deployment file", path, () =>
        readFile(path, "utf8"),
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
    yield* runCommand("vercel", ["env", "rm", name, "production", "--yes"], cwd, {
      allowFailure: true,
    });
    yield* runCommand("vercel", ["env", "add", name, "production"], cwd, {
      stdin: `${value}\n`,
    });
  });
}

function writeLocalConfig(plan: DeployPlan): Effect.Effect<void, DeploymentGenerationFailed> {
  const configPath = join(homedir(), ".turbotunnel", "config.json");
  return Effect.gen(function* () {
    yield* fsOperation("create local config directory", dirname(configPath), () =>
      mkdir(dirname(configPath), { recursive: true }),
    );
    yield* fsOperation("write local tunnel config", configPath, () =>
      writeFile(
        configPath,
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
      ),
    );
  });
}

function fsOperation<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, DeploymentGenerationFailed> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DeploymentGenerationFailed({
        operation,
        path,
        cause,
        message: `Unable to ${operation} at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
      }),
  });
}
