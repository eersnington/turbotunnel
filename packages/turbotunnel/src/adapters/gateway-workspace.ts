import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TURBOTUNNEL_VERSION } from "@turbotunnel/protocol";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";

import { GatewayWorkspaceError } from "../errors.js";

export type GatewayWorkspaceShape = {
  readonly generate: (deployDir: string) => Effect.Effect<void, GatewayWorkspaceError>;
};

export class GatewayWorkspace extends Context.Service<GatewayWorkspace, GatewayWorkspaceShape>()(
  "turbotunnel/effect/GatewayWorkspace",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return GatewayWorkspace.of({ generate: (deployDir) => generateWorkspace(fs, deployDir) });
    }),
  );
}

type GatewayDeploymentSource = {
  readonly templateDir: string;
  readonly gatewaySrcDir: string;
  readonly protocolSrcDir: string;
};

function generateWorkspace(
  fs: FileSystem,
  deployDir: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    const source = yield* resolveGatewayDeploymentSource(fs);
    yield* cleanGeneratedDeploymentDirectory(fs, deployDir);
    yield* makeDirectory(fs, deployDir, "create generated gateway directory");
    yield* writeGeneratedPackageJson(fs, deployDir);
    yield* copyFileFromTemplate(fs, source.templateDir, deployDir, "api/server.ts", (text) =>
      text.replace('from "@turbotunnel/gateway"', 'from "../src/gateway/index.js"'),
    );
    yield* writeGeneratedTsconfig(fs, deployDir);
    yield* copyFileFromTemplate(fs, source.templateDir, deployDir, "vercel.json");
    yield* copyDirectory(fs, source.protocolSrcDir, join(deployDir, "src", "protocol"));
    yield* copyDirectory(fs, source.gatewaySrcDir, join(deployDir, "src", "gateway"), (text) =>
      text.replaceAll('from "@turbotunnel/protocol"', 'from "../protocol/index.js"'),
    );
    yield* assertStandalone(fs, deployDir);
  });
}

function resolveGatewayDeploymentSource(
  fs: FileSystem,
): Effect.Effect<GatewayDeploymentSource, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    const here = dirname(fileURLToPath(import.meta.url));
    const packagedCandidates = [
      resolve(here, "..", "..", "gateway-template"),
      resolve(here, "..", "gateway-template"),
    ];

    for (const candidate of packagedCandidates) {
      if (yield* directoryExists(fs, candidate)) {
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

function directoryExists(fs: FileSystem, path: string): Effect.Effect<boolean, GatewayWorkspaceError> {
  return fs.stat(path).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.catchTag("PlatformError", (cause) => {
      if (cause.reason._tag === "NotFound") {
        return Effect.succeed(false);
      }

      return Effect.fail(workspaceError("stat deployment source directory", path, cause));
    }),
  );
}

function cleanGeneratedDeploymentDirectory(
  fs: FileSystem,
  deployDir: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(deployDir).pipe(
      Effect.mapError((cause) => workspaceError("check generated gateway directory", deployDir, cause)),
    );
    if (!exists) {
      return;
    }

    const entries = yield* fs.readDirectory(deployDir).pipe(
      Effect.mapError((cause) => workspaceError("read generated gateway directory", deployDir, cause)),
    );
    for (const entry of entries) {
      if (entry === ".vercel") {
        continue;
      }

      const path = join(deployDir, entry);
      yield* fs.remove(path, { recursive: true, force: true }).pipe(
        Effect.mapError((cause) => workspaceError("remove stale generated gateway path", path, cause)),
      );
    }
  });
}

function copyFileFromTemplate(
  fs: FileSystem,
  templateDir: string,
  deployDir: string,
  relativePath: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, GatewayWorkspaceError> {
  const source = join(templateDir, relativePath);
  const target = join(deployDir, relativePath);
  return Effect.gen(function* () {
    yield* makeDirectory(fs, dirname(target), "create generated file parent");
    const text = yield* fs.readFileString(source, "utf8").pipe(
      Effect.mapError((cause) => workspaceError("read gateway template file", source, cause)),
    );
    yield* fs.writeFileString(target, transform(text)).pipe(
      Effect.mapError((cause) => workspaceError("write generated gateway file", target, cause)),
    );
  });
}

function copyDirectory(
  fs: FileSystem,
  source: string,
  target: string,
  transform: (text: string) => string = (text) => text,
): Effect.Effect<void, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    yield* makeDirectory(fs, target, "create generated directory");
    const entries = yield* fs.readDirectory(source).pipe(
      Effect.mapError((cause) => workspaceError("read source directory", source, cause)),
    );
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
        continue;
      }

      const sourcePath = join(source, entry);
      const targetPath = join(target, entry);
      const stats = yield* fs.stat(sourcePath).pipe(
        Effect.mapError((cause) => workspaceError("stat source path", sourcePath, cause)),
      );
      if (stats.type === "Directory") {
        yield* copyDirectory(fs, sourcePath, targetPath, transform);
        continue;
      }

      yield* makeDirectory(fs, dirname(targetPath), "create generated file parent");
      if (sourcePath.endsWith(".ts")) {
        const text = yield* fs.readFileString(sourcePath, "utf8").pipe(
          Effect.mapError((cause) => workspaceError("read source TypeScript file", sourcePath, cause)),
        );
        yield* fs.writeFileString(targetPath, transform(text)).pipe(
          Effect.mapError((cause) => workspaceError("write generated TypeScript file", targetPath, cause)),
        );
        continue;
      }

      const bytes = yield* fs.readFile(sourcePath).pipe(
        Effect.mapError((cause) => workspaceError("read source file", sourcePath, cause)),
      );
      yield* fs.writeFile(targetPath, bytes).pipe(
        Effect.mapError((cause) => workspaceError("write generated file", targetPath, cause)),
      );
    }
  });
}

function writeGeneratedPackageJson(
  fs: FileSystem,
  deployDir: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  const path = join(deployDir, "package.json");
  return fs
    .writeFileString(
      path,
      `${JSON.stringify(
        {
          name: "turbotunnel-gateway-deployment",
          version: TURBOTUNNEL_VERSION,
          private: true,
          type: "module",
          dependencies: { effect: "4.0.0-beta.92", nanoid: "^5.1.6", ws: "^8.18.3" },
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
    .pipe(Effect.mapError((cause) => workspaceError("write generated package.json", path, cause)));
}

function writeGeneratedTsconfig(
  fs: FileSystem,
  deployDir: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  const path = join(deployDir, "tsconfig.json");
  return fs
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
    .pipe(Effect.mapError((cause) => workspaceError("write generated tsconfig.json", path, cause)));
}

function assertStandalone(
  fs: FileSystem,
  deployDir: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    const matches = yield* filesContainingAny(fs, deployDir, [
      "@turbotunnel/gateway",
      "@turbotunnel/protocol",
      "@turbotunnel/typescript-config",
    ]);
    if (matches.length > 0) {
      return yield* new GatewayWorkspaceError({
        operation: "assert generated deployment standalone",
        path: deployDir,
        cause: matches,
        message: `Generated gateway deployment still contains workspace-only imports in ${matches.join(", ")}. No gateway was deployed.`,
      });
    }
  });
}

function filesContainingAny(
  fs: FileSystem,
  directory: string,
  needles: ReadonlyArray<string>,
): Effect.Effect<Array<string>, GatewayWorkspaceError> {
  return Effect.gen(function* () {
    const matches: Array<string> = [];
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError((cause) => workspaceError("read generated deployment directory", directory, cause)),
    );
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".vercel") {
        continue;
      }

      const path = join(directory, entry);
      const stats = yield* fs.stat(path).pipe(
        Effect.mapError((cause) => workspaceError("stat generated deployment path", path, cause)),
      );
      if (stats.type === "Directory") {
        matches.push(...(yield* filesContainingAny(fs, path, needles)));
        continue;
      }

      if (!path.endsWith(".ts") && !path.endsWith(".json")) {
        continue;
      }

      const text = yield* fs.readFileString(path, "utf8").pipe(
        Effect.mapError((cause) => workspaceError("read generated deployment file", path, cause)),
      );
      if (needles.some((needle) => text.includes(needle))) {
        matches.push(path);
      }
    }

    return matches;
  });
}

function makeDirectory(
  fs: FileSystem,
  path: string,
  operation: string,
): Effect.Effect<void, GatewayWorkspaceError> {
  return fs.makeDirectory(path, { recursive: true }).pipe(
    Effect.mapError((cause) => workspaceError(operation, path, cause)),
  );
}

function workspaceError(operation: string, path: string, cause: unknown): GatewayWorkspaceError {
  return new GatewayWorkspaceError({
    operation,
    path,
    cause,
    message: `Failed to ${operation} at ${path}. No gateway was deployed and your local tunnel config was not changed.`,
  });
}
