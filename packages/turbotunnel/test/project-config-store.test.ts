import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ProjectConfigStore } from "../src/adapters/project-config-store.js";

describe("ProjectConfigStore", () => {
  it.effect("selects an arbitrary monorepo target from cwd and applies shared access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-config-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const dashboard = join(root, "packages", "dashboard");
        const nested = join(dashboard, "src", "screens");
        yield* Effect.promise(() => mkdir(nested, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            join(root, "turbotunnel.json"),
            JSON.stringify({
              access: { type: "public" },
              projects: {
                dashboard: {
                  root: "packages/dashboard",
                  dev: "vp run dev",
                  port: 3000,
                  slug: "dashboard",
                },
                docs: { root: "docs", port: 5173 },
              },
            }),
          ),
        );

        const selected = yield* Effect.gen(function* () {
          return yield* (yield* ProjectConfigStore).discover(nested);
        }).pipe(Effect.provide(ProjectConfigStore.live), Effect.provide(NodeServices.layer));

        expect(selected).toMatchObject({
          name: "dashboard",
          root: dashboard,
          dev: "vp run dev",
          port: 3000,
          slug: "dashboard",
          access: { type: "public" },
        });
      }),
    ),
  );
});
