import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";

import { LocalConfigStore } from "../src/adapters/local-config-store.js";

describe("LocalConfigStore", () => {
  it.effect("reads a missing config as empty", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      const config = yield* readConfig(path);

      expect(config).toEqual({});
    }),
  );

  it.effect("rejects invalid JSON", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      yield* Effect.promise(() => writeFile(path, "{ nope", "utf8"));

      const error = yield* readConfig(path).pipe(Effect.flip);

      expect(error._tag).toBe("ConfigFileParseError");
    }),
  );

  it.effect("rejects config files with unsupported field shapes", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      yield* Effect.promise(() => writeFile(path, JSON.stringify({ project: 42 }), "utf8"));

      const error = yield* readConfig(path).pipe(Effect.flip);

      expect(error._tag).toBe("ConfigFileParseError");
    }),
  );

  it.effect("writes and reads deploy config", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      const readBack = yield* Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        yield* store.update({
          project: "demo-turbotunnel",
          slug: "demo",
          relayDomain: "tunnel.example.com",
          relaySecret: "secret",
          queueRegion: "iad1",
        });
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer));

      expect(readBack).toMatchObject({
        project: "demo-turbotunnel",
        slug: "demo",
        relayDomain: "tunnel.example.com",
        relaySecret: "secret",
        queueRegion: "iad1",
      });
      const written = yield* Effect.promise(() => readFile(path, "utf8"));
      expect(JSON.parse(written)).toMatchObject({
        project: "demo-turbotunnel",
        slug: "demo",
        relayDomain: "tunnel.example.com",
        relaySecret: "secret",
        queueRegion: "iad1",
      });
    }),
  );

  it.effect("preserves project identity and domain assignments across deploy writes", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            teamId: "team_123",
            projectId: "prj_123",
            relayUrl: "https://relay.example.com",
            domainAssignments: [
              {
                configIdentity: "/repo/turbotunnel.json",
                targetName: "dashboard",
                targetPath: "/repo/apps/dashboard",
                domain: "dashboard-turbotunnel.vercel.app",
                slug: "dashboard",
              },
            ],
          }),
          "utf8",
        ),
      );

      const readBack = yield* Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        yield* store.update({
          project: "gateway",
          slug: "ttabc123",
          relayDomain: "{slug}-turbotunnel.vercel.app",
          relaySecret: "secret",
          queueRegion: "iad1",
        });
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer));

      expect(readBack).toMatchObject({
        teamId: "team_123",
        projectId: "prj_123",
        relayUrl: "https://relay.example.com",
        domainAssignments: [expect.objectContaining({ targetName: "dashboard" })],
      });
    }),
  );

  it.effect("serializes concurrent updates within one store instance", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      const readBack = yield* Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        yield* Effect.all(
          [store.update({ project: "gateway" }), store.update({ teamId: "team_123" })],
          { concurrency: "unbounded" },
        );
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer));

      expect(readBack).toMatchObject({ project: "gateway", teamId: "team_123" });
    }),
  );

  it.effect("removes the secret-bearing temp file when the atomic rename fails", () =>
    Effect.gen(function* () {
      const path = yield* tempConfigPath;
      const fileSystem = yield* FileSystem;
      const failingRename = Layer.succeed(FileSystem, {
        ...fileSystem,
        rename: (oldPath, newPath) =>
          fileSystem
            .makeDirectory(newPath)
            .pipe(Effect.andThen(fileSystem.rename(oldPath, newPath))),
      });

      const error = yield* Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        return yield* store.update({ relaySecret: "secret" });
      }).pipe(
        Effect.provide(LocalConfigStore.layer(path)),
        Effect.provide(failingRename),
        Effect.flip,
      );

      expect(error._tag).toBe("ConfigFileWriteError");
      expect(yield* Effect.promise(() => readdir(join(path, "..")))).toEqual(["config.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const tempConfigPath = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-effect-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.orDie),
).pipe(Effect.map((dir) => join(dir, "config.json")));

const readConfig = (path: string) =>
  Effect.gen(function* () {
    const store = yield* LocalConfigStore;
    return yield* store.read;
  }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer));
