import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";

import { GatewayWorkspaceError } from "../errors.js";

export type GatewayWorkspaceShape = {
  readonly copyTo: (deployDir: string) => Effect.Effect<void, GatewayWorkspaceError>;
};

/** Copies the gateway-owned standalone deployment artifact into the CLI deployment directory. */
export class GatewayWorkspace extends Context.Service<GatewayWorkspace, GatewayWorkspaceShape>()(
  "turbotunnel/effect/GatewayWorkspace",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return GatewayWorkspace.of({ copyTo: (deployDir) => copyWorkspace(fs, deployDir) });
    }),
  );
}

const copyWorkspace = Effect.fn("GatewayWorkspace.copy")(function* (
  fs: FileSystem,
  deployDir: string,
): Effect.fn.Return<void, GatewayWorkspaceError> {
  const sourceDir = yield* resolveGatewayDeploymentArtifact(fs);
  yield* cleanDeploymentDirectory(fs, deployDir);
  yield* fs
    .makeDirectory(deployDir, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        workspaceError("create gateway deployment directory", deployDir, cause),
      ),
    );
  const entries = yield* fs
    .readDirectory(sourceDir)
    .pipe(
      Effect.mapError((cause) =>
        workspaceError("read gateway deployment artifact", sourceDir, cause),
      ),
    );
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry);
    yield* fs
      .copy(sourcePath, join(deployDir, entry), { overwrite: true })
      .pipe(
        Effect.mapError((cause) =>
          workspaceError("copy gateway deployment artifact", sourcePath, cause),
        ),
      );
  }
});

const resolveGatewayDeploymentArtifact = Effect.fn("GatewayWorkspace.resolveArtifact")(function* (
  fs: FileSystem,
): Effect.fn.Return<string, GatewayWorkspaceError> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "gateway", "dist", "deployment"),
    resolve(here, "..", "..", "gateway-template"),
    resolve(here, "..", "gateway-template"),
  ];

  for (const candidate of candidates) {
    if (yield* isDirectory(fs, candidate)) {
      return candidate;
    }
  }

  return yield* new GatewayWorkspaceError({
    operation: "resolve gateway deployment artifact",
    cause: candidates,
    message:
      "The gateway deployment artifact is missing. Rebuild the Turbotunnel package before deploying; local tunnel config was not changed.",
  });
});

function isDirectory(fs: FileSystem, path: string): Effect.Effect<boolean, GatewayWorkspaceError> {
  return fs.stat(path).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.catchTag("PlatformError", (cause) => {
      if (cause.reason._tag === "NotFound") {
        return Effect.succeed(false);
      }
      return Effect.fail(workspaceError("stat gateway deployment artifact", path, cause));
    }),
  );
}

const cleanDeploymentDirectory = Effect.fn("GatewayWorkspace.clean")(function* (
  fs: FileSystem,
  deployDir: string,
): Effect.fn.Return<void, GatewayWorkspaceError> {
  if (
    !(yield* fs
      .exists(deployDir)
      .pipe(
        Effect.mapError((cause) =>
          workspaceError("check gateway deployment directory", deployDir, cause),
        ),
      ))
  ) {
    return;
  }

  const entries = yield* fs
    .readDirectory(deployDir)
    .pipe(
      Effect.mapError((cause) =>
        workspaceError("read gateway deployment directory", deployDir, cause),
      ),
    );
  for (const entry of entries) {
    if (entry === ".vercel") {
      continue;
    }

    const path = join(deployDir, entry);
    yield* fs
      .remove(path, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          workspaceError("remove stale gateway deployment path", path, cause),
        ),
      );
  }
});

function workspaceError(operation: string, path: string, cause: unknown): GatewayWorkspaceError {
  return new GatewayWorkspaceError({
    operation,
    path,
    cause,
    message: `Failed to ${operation} at ${path}. No gateway was deployed and local tunnel config was not changed.`,
  });
}
