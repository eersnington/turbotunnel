import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ProjectConfigStore } from "../src/adapters/project-config-store.js";

describe("ProjectConfigStore", () => {
  it.effect("selects a named project with tunnel-only configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("turbotunnel-config-");
        yield* Effect.promise(() =>
          writeFile(
            join(root, "turbotunnel.json"),
            JSON.stringify({
              access: { type: "public" },
              projects: {
                dashboard: {
                  port: 3000,
                  domain: "dashboard.example.com",
                  access: { type: "password" },
                },
                docs: { port: 5173, slug: "docs" },
              },
            }),
          ),
        );

        const selected = yield* discover(root, "dashboard");

        expect(selected).toMatchObject({
          name: "dashboard",
          configRoot: root,
          port: 3000,
          domain: "dashboard.example.com",
          access: { type: "password" },
        });
      }),
    ),
  );

  it.effect("selects the only configured project without a name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("turbotunnel-single-config-");
        yield* Effect.promise(() =>
          writeFile(
            join(root, "turbotunnel.json"),
            JSON.stringify({ projects: { docs: { port: 5173, slug: "docs" } } }),
          ),
        );

        expect(yield* discover(root)).toMatchObject({ name: "docs", port: 5173, slug: "docs" });
      }),
    ),
  );

  it.effect("requires a project name non-interactively when multiple are configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("turbotunnel-multiple-config-");
        yield* Effect.promise(() =>
          writeFile(
            join(root, "turbotunnel.json"),
            JSON.stringify({
              projects: {
                dashboard: { port: 3000 },
                docs: { port: 5173 },
              },
            }),
          ),
        );

        const error = yield* discover(root).pipe(Effect.flip);
        expect(error._tag).toBe("CliConfigError");
        expect(error.message).toContain("dashboard");
        expect(error.message).toContain("docs");
      }),
    ),
  );

  it.effect("rejects removed process configuration fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("turbotunnel-removed-config-");
        for (const [field, value] of [
          ["root", "packages/dashboard"],
          ["dev", "pnpm dev"],
          ["env", {}],
        ] as const) {
          yield* Effect.promise(() =>
            writeFile(
              join(root, "turbotunnel.json"),
              JSON.stringify({ projects: { dashboard: { port: 3000, [field]: value } } }),
            ),
          );
          expect((yield* discover(root, "dashboard").pipe(Effect.flip))._tag).toBe(
            "ConfigFileParseError",
          );
        }
      }),
    ),
  );
});

const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
  );

const discover = (cwd: string, projectName?: string) =>
  Effect.gen(function* () {
    return yield* (yield* ProjectConfigStore).discover(cwd, projectName);
  }).pipe(Effect.provide(ProjectConfigStore.live), Effect.provide(NodeServices.layer));
