import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { RuntimeRegistry } from "../src/adapters/runtime-registry.js";
import type { RuntimeRecord } from "../src/domain/tunnel-lifecycle.js";

describe("RuntimeRegistry", () => {
  it.effect("writes one atomic strict-schema record and removes it with the scope", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const sessionsDir = directory;
      const record = runtimeRecord("ses_live", "token-live");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          yield* registry.register(record);

          expect(yield* registry.list).toEqual([record]);
          expect((yield* Effect.promise(() => readdir(sessionsDir))).sort()).toEqual([
            "ses_live.json",
          ]);
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(sessionsDir, "ses_live.json"), "utf8")),
            ),
          ).toEqual(record);
        }),
      ).pipe(
        Effect.provide(RuntimeRegistry.layer(sessionsDir)),
        Effect.provide(NodeServices.layer),
      );

      expect(yield* Effect.promise(() => readdir(sessionsDir))).toEqual([]);
    }),
  );

  it.effect("removes records with excess fields instead of trusting them", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const sessionsDir = directory;
      yield* Effect.promise(() =>
        writeFile(
          join(sessionsDir, "ses_invalid.json"),
          JSON.stringify({ ...runtimeRecord("ses_invalid", "token"), injected: true }),
        ),
      );

      const records = yield* Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        return yield* registry.list;
      }).pipe(
        Effect.provide(RuntimeRegistry.layer(sessionsDir)),
        Effect.provide(NodeServices.layer),
      );

      expect(records).toEqual([]);
      expect(yield* Effect.promise(() => readdir(sessionsDir))).toEqual([]);
    }),
  );

  it.effect("does not remove a record owned by another process token", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const sessionsDir = directory;
      const current = runtimeRecord("ses_shared", "new-token");
      yield* Effect.promise(() =>
        writeFile(join(sessionsDir, "ses_shared.json"), JSON.stringify(current)),
      );

      yield* Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        yield* registry.remove(runtimeRecord("ses_shared", "old-token"));
      }).pipe(
        Effect.provide(RuntimeRegistry.layer(sessionsDir)),
        Effect.provide(NodeServices.layer),
      );

      expect(
        JSON.parse(
          yield* Effect.promise(() => readFile(join(sessionsDir, "ses_shared.json"), "utf8")),
        ),
      ).toEqual(current);
    }),
  );
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-registry-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);

function runtimeRecord(sessionId: string, processToken: string): RuntimeRecord {
  return {
    version: 1,
    sessionId,
    pid: 123,
    processToken,
    startedAt: 1_000,
    slug: "demo",
    publicUrl: "https://demo.example.com/",
    localUrl: "http://localhost:5173",
    controlSocketPath: join(tmpdir(), `${sessionId}.sock`),
  };
}
