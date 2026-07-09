import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { GatewayWorkspace } from "../src/adapters/gateway-workspace.js";

const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GatewayWorkspace", () => {
  test("generates a standalone workspace from packaged templates", async () => {
    const dir = await tempDir();
    const deployDir = join(dir, "relay");

    await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* GatewayWorkspace;
        yield* workspace.generate(deployDir);
      }).pipe(Effect.provide(GatewayWorkspace.live), Effect.provide(NodeServices.layer)),
    );

    const server = await readFile(join(deployDir, "api", "server.ts"), "utf8");
    const gateway = await readFile(join(deployDir, "src", "gateway", "index.ts"), "utf8");
    const contracts = await readFile(join(deployDir, "src", "contracts", "index.ts"), "utf8");
    const generatedPackage = JSON.parse(await readFile(join(deployDir, "package.json"), "utf8"));

    expect(server).toContain('from "../src/gateway/index.js"');
    expect(gateway).not.toContain("@turbotunnel/contracts");
    expect(contracts).toContain("./frames.js");
    expect(generatedPackage.name).toBe("turbotunnel-gateway-deployment");
  });

});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turbotunnel-workspace-"));
  tempDirs.push(dir);
  return dir;
}
