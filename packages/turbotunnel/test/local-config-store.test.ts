import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { LocalConfigStore } from "../src/adapters/local-config-store.js";

const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("LocalConfigStore", () => {
  test("reads a missing config as empty", async () => {
    const path = await tempConfigPath();
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer)),
    );

    expect(config).toEqual({});
  });

  test("rejects invalid JSON", async () => {
    const path = await tempConfigPath();
    await writeFile(path, "{ nope", "utf8");

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer)),
    );

    expect(exit._tag).toBe("Failure");
  });

  test("rejects config files with unsupported field shapes", async () => {
    const path = await tempConfigPath();
    await writeFile(path, JSON.stringify({ project: 42 }), "utf8");

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer)),
    );

    expect(exit._tag).toBe("Failure");
  });

  test("writes and reads deploy config", async () => {
    const path = await tempConfigPath();
    const readBack = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* LocalConfigStore;
        yield* store.write({
          project: "demo-turbotunnel",
          slug: "demo",
          relayDomain: "tunnel.example.com",
          relaySecret: "secret",
          queueRegion: "iad1",
        });
        return yield* store.read;
      }).pipe(Effect.provide(LocalConfigStore.layer(path)), Effect.provide(NodeServices.layer)),
    );

    expect(readBack).toMatchObject({
      project: "demo-turbotunnel",
      slug: "demo",
      relayDomain: "tunnel.example.com",
      relaySecret: "secret",
      queueRegion: "iad1",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      project: "demo-turbotunnel",
      slug: "demo",
      relayDomain: "tunnel.example.com",
      relaySecret: "secret",
      queueRegion: "iad1",
    });
  });
});

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turbotunnel-effect-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}
