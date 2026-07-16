import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ProjectDiscovery } from "../src/adapters/project-discovery.js";

describe("ProjectDiscovery", () => {
  it.effect("walks upward and gives packageManager precedence over lockfiles", () =>
    withProject(
      {
        packageManager: "pnpm@10.0.0",
        scripts: { dev: "vite" },
        devDependencies: { vite: "latest" },
      },
      ["package-lock.json", "yarn.lock"],
      Effect.fn(function* (root) {
        const nested = join(root, "src", "nested");
        yield* Effect.promise(() => mkdir(nested, { recursive: true }));

        const discovered = yield* discover(nested);

        expect(discovered.root).toBe(root);
        expect(discovered.packageManager).toBe("pnpm");
      }),
    ),
  );

  it.effect("executes in the nearest package while using ancestor package manager metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const project = join(root, "packages", "web");
        const nested = join(project, "src");
        yield* Effect.promise(() => mkdir(nested, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10" })),
        );
        yield* Effect.promise(() =>
          writeFile(join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } })),
        );
        yield* Effect.promise(() => writeFile(join(project, "package-lock.json"), ""));
        yield* Effect.promise(() => writeFile(join(project, "yarn.lock"), ""));

        const discovered = yield* discover(nested);

        expect(discovered.root).toBe(project);
        expect(discovered.packageJsonPath).toBe(join(project, "package.json"));
        expect(discovered.packageManager).toBe("pnpm");
        expect(discovered.scripts.dev).toBe("vite");
      }),
    ),
  );

  it.effect("uses the nearest lockfile directory when no packageManager field exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const project = join(root, "packages", "web");
        yield* Effect.promise(() => mkdir(project, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(root, "package.json"), "{}"));
        yield* Effect.promise(() => writeFile(join(root, "pnpm-lock.yaml"), ""));
        yield* Effect.promise(() =>
          writeFile(join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } })),
        );
        yield* Effect.promise(() => writeFile(join(project, "yarn.lock"), ""));

        expect((yield* discover(project)).packageManager).toBe("yarn");
      }),
    ),
  );

  it.effect("rejects conflicting lockfiles when packageManager is absent", () =>
    withProject(
      { scripts: { dev: "next dev" } },
      ["pnpm-lock.yaml", "bun.lock"],
      Effect.fn(function* (root) {
        const error = yield* discover(root).pipe(Effect.flip);
        expect(error._tag).toBe("ConflictingLockfiles");
      }),
    ),
  );

  it.effect("falls back to npm without a packageManager or lockfile", () =>
    withProject(
      { scripts: { dev: "node server.js" } },
      [],
      Effect.fn(function* (root) {
        expect((yield* discover(root)).packageManager).toBe("npm");
      }),
    ),
  );
});

function withProject<A>(
  manifest: unknown,
  lockfiles: ReadonlyArray<string>,
  use: (root: string) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-project-"))),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
      );
      yield* Effect.promise(() => writeFile(join(root, "package.json"), JSON.stringify(manifest)));
      yield* Effect.forEach(lockfiles, (name) =>
        Effect.promise(() => writeFile(join(root, name), "")),
      );
      return yield* use(root);
    }),
  );
}

const discover = (cwd: string) =>
  Effect.gen(function* () {
    return yield* (yield* ProjectDiscovery).discover(cwd);
  }).pipe(Effect.provide(ProjectDiscovery.live), Effect.provide(NodeServices.layer));

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-monorepo-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
);
