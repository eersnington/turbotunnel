import { dirname, join, parse } from "node:path";

import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

import type { DevProject, PackageManager } from "../domain/dev-project.js";
import {
  ConflictingLockfiles,
  ProjectManifestError,
  ProjectNotFound,
  UnsupportedPackageManager,
} from "../errors.js";

type ProjectDiscoveryError =
  | ProjectNotFound
  | ProjectManifestError
  | UnsupportedPackageManager
  | ConflictingLockfiles;

export type ProjectDiscoveryShape = {
  readonly discover: (cwd: string) => Effect.Effect<DevProject, ProjectDiscoveryError>;
};

export class ProjectDiscovery extends Context.Service<ProjectDiscovery, ProjectDiscoveryShape>()(
  "turbotunnel/effect/ProjectDiscovery",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return ProjectDiscovery.of({ discover: (cwd) => discoverProject(fs, cwd) });
    }),
  );
}

const ManifestSchema = Schema.Struct({
  packageManager: Schema.optional(Schema.String),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema));

const LOCKFILES: ReadonlyArray<readonly [PackageManager, string]> = [
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"],
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
];

const discoverProject = Effect.fn("ProjectDiscovery.discover")(function* (
  fs: FileSystem,
  cwd: string,
): Effect.fn.Return<DevProject, ProjectDiscoveryError> {
  let directory = cwd;
  const root = parse(directory).root;
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    const exists = yield* fs
      .exists(packageJsonPath)
      .pipe(Effect.mapError((cause) => manifestReadError(packageJsonPath, cause)));
    if (exists) {
      const text = yield* fs
        .readFileString(packageJsonPath, "utf8")
        .pipe(Effect.mapError((cause) => manifestReadError(packageJsonPath, cause)));
      const manifest = yield* decodeManifest(text).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectManifestError({
              path: packageJsonPath,
              cause,
              message: `Couldn't parse ${packageJsonPath}. Fix its JSON and package metadata, then retry. No child process or tunnel was started.`,
            }),
        ),
      );
      const packageManager = yield* resolvePackageManager(fs, directory, manifest);
      return {
        root: directory,
        packageJsonPath,
        packageManager,
        scripts: manifest.scripts ?? {},
      };
    }
    if (directory === root) break;
    directory = dirname(directory);
  }

  return yield* new ProjectNotFound({
    cwd,
    message: `Couldn't find a package.json from ${cwd} or any parent directory. Run \`tt dev\` inside a JavaScript project. No child process or tunnel was started.`,
  });
});

const resolvePackageManager = Effect.fn("ProjectDiscovery.resolvePackageManager")(function* (
  fs: FileSystem,
  projectRoot: string,
  projectManifest: typeof ManifestSchema.Type,
): Effect.fn.Return<
  PackageManager,
  ProjectManifestError | UnsupportedPackageManager | ConflictingLockfiles
> {
  const directories = ancestorDirectories(projectRoot);
  for (const directory of directories) {
    const packageJsonPath = join(directory, "package.json");
    const manifest =
      directory === projectRoot
        ? projectManifest
        : yield* readOptionalManifest(fs, packageJsonPath);
    const packageManagerField = manifest?.packageManager;
    if (packageManagerField === undefined) continue;

    const name = packageManagerField.split("@")[0];
    if (isPackageManager(name)) return name;
    return yield* new UnsupportedPackageManager({
      packageManager: packageManagerField,
      path: packageJsonPath,
      message: `Package manager \`${packageManagerField}\` is not supported. Use npm, pnpm, yarn, or bun in package.json, then retry. No child process or tunnel was started.`,
    });
  }

  for (const directory of directories) {
    const detected = new Map<PackageManager, Array<string>>();
    for (const [packageManager, lockfile] of LOCKFILES) {
      const path = join(directory, lockfile);
      const exists = yield* fs
        .exists(path)
        .pipe(Effect.mapError((cause) => manifestReadError(path, cause)));
      if (exists) detected.set(packageManager, [...(detected.get(packageManager) ?? []), lockfile]);
    }
    if (detected.size > 1) {
      const lockfiles = [...detected.values()].flat();
      return yield* new ConflictingLockfiles({
        root: directory,
        lockfiles,
        message: `Conflicting lockfiles were found in ${directory}: ${lockfiles.join(", ")}. Keep one package manager's lockfile or set packageManager in package.json, then retry. No child process or tunnel was started.`,
      });
    }
    const packageManager = detected.keys().next().value;
    if (packageManager !== undefined) return packageManager;
  }
  return "npm";
});

const readOptionalManifest = Effect.fn("ProjectDiscovery.readOptionalManifest")(function* (
  fs: FileSystem,
  path: string,
): Effect.fn.Return<typeof ManifestSchema.Type | undefined, ProjectManifestError> {
  const exists = yield* fs
    .exists(path)
    .pipe(Effect.mapError((cause) => manifestReadError(path, cause)));
  if (!exists) return undefined;
  const text = yield* fs
    .readFileString(path, "utf8")
    .pipe(Effect.mapError((cause) => manifestReadError(path, cause)));
  return yield* decodeManifest(text).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectManifestError({
          path,
          cause,
          message: `Couldn't parse ${path}. Fix its JSON and package metadata, then retry. No child process or tunnel was started.`,
        }),
    ),
  );
});

function ancestorDirectories(start: string): ReadonlyArray<string> {
  const directories: Array<string> = [];
  const root = parse(start).root;
  let directory = start;
  while (true) {
    directories.push(directory);
    if (directory === root) return directories;
    directory = dirname(directory);
  }
}

function manifestReadError(path: string, cause: unknown): ProjectManifestError {
  return new ProjectManifestError({
    path,
    cause,
    message: `Couldn't read project metadata at ${path}. Check file permissions and retry. No child process or tunnel was started.`,
  });
}

function isPackageManager(value: string | undefined): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}
