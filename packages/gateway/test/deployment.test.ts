import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { buildGatewayDeployment } from "../scripts/build-deployment.js";

const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("buildGatewayDeployment", () => {
  test("builds and validates a standalone gateway deployment artifact", async () => {
    const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const outputDir = await tempDir();
    await buildGatewayDeployment({
      gatewayRoot,
      contractsRoot: resolve(gatewayRoot, "..", "contracts"),
      outputDir,
    });

    const server = await readFile(join(outputDir, "api", "server.ts"), "utf8");
    const gateway = await readFile(join(outputDir, "src", "gateway", "index.ts"), "utf8");
    const contracts = await readFile(join(outputDir, "src", "contracts", "index.ts"), "utf8");
    const packageText = await readFile(join(outputDir, "package.json"), "utf8");
    const vercelText = await readFile(join(outputDir, "vercel.json"), "utf8");
    const generatedPackage: unknown = JSON.parse(packageText);
    const generatedVercel: unknown = JSON.parse(vercelText);

    expect(server).toContain('from "../src/gateway/index.js"');
    expect(gateway).not.toContain("@turbotunnel/contracts");
    expect(contracts).toContain("./frames.js");
    expect(generatedPackage).toMatchObject({
      name: "turbotunnel-gateway-deployment",
      private: true,
    });
    expect(generatedVercel).toMatchObject({
      fluid: true,
      functions: { "api/server.ts": { maxDuration: 300 } },
    });
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turbotunnel-gateway-deployment-"));
  tempDirs.push(dir);
  return dir;
}
