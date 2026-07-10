import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { GatewayWorkspace } from "../src/adapters/gateway-workspace.js";

const tempDirs: Array<string> = [];
const gatewayRoot = join(import.meta.dirname, "..", "..", "gateway");
const gatewayArtifactDir = join(gatewayRoot, "dist", "deployment");

beforeAll(async () => {
  await run("bun", ["run", "--cwd", gatewayRoot, "build"]);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GatewayWorkspace", () => {
  test("copies the standalone gateway artifact without constructing runtime files", async () => {
    const dir = await tempDir();
    const deployDir = join(dir, "relay");
    const vercelMetadataPath = join(deployDir, ".vercel", "project.json");
    await mkdir(join(deployDir, ".vercel"), { recursive: true });
    await writeFile(vercelMetadataPath, "linked-project\n");

    await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* GatewayWorkspace;
        yield* workspace.copyTo(deployDir);
      }).pipe(Effect.provide(GatewayWorkspace.live), Effect.provide(NodeServices.layer)),
    );

    expect(await directorySnapshot(deployDir, [".vercel"])).toEqual(
      await directorySnapshot(gatewayArtifactDir),
    );
    expect(await readFile(vercelMetadataPath, "utf8")).toBe("linked-project\n");
  });
});

function run(command: string, arguments_: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "pipe" });
    const stderr: Array<Buffer> = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Gateway artifact build failed: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function directorySnapshot(
  directory: string,
  excludedEntries: ReadonlyArray<string> = [],
  prefix = "",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedEntries.includes(entry.name)) {
      continue;
    }
    const relativePath = prefix.length === 0 ? entry.name : join(prefix, entry.name);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await directorySnapshot(path, [], relativePath));
      continue;
    }
    snapshot[relativePath] = (await readFile(path)).toString("base64");
  }
  return snapshot;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turbotunnel-workspace-"));
  tempDirs.push(dir);
  return dir;
}
