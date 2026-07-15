import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { VercelCli } from "../src/adapters/vercel-cli.js";

const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("VercelCli.live", () => {
  test("requireInstalled spawns vercel --version", async () => {
    const fake = await fakeVercel(`
if (command === "--version") {
  console.log("vercel 99.0.0");
  process.exit(0);
}
process.exit(1);
`);

    await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      yield* vercel.requireInstalled;
    })));

    expect(await readCalls(fake.callsPath)).toEqual([
      expect.objectContaining({ argv: ["--version"] }),
    ]);
  });

  test("requireInstalled returns a typed not-found error when vercel is missing", async () => {
    const emptyDir = await tempDir("turbotunnel-empty-path-");
    const error = await withPath(emptyDir, () =>
      runVercel(Effect.gen(function* () {
        const vercel = yield* VercelCli;
        return yield* vercel.requireInstalled;
      }).pipe(Effect.flip)),
    );

    expect(error._tag).toBe("VercelCliNotFound");
    expect(error.message).toContain("Vercel CLI is required");
    expect(error.message).toContain("No gateway was deployed");
  });

  test("requireInstalled reports spawn failures without fabricating an exit code", async () => {
    const binDir = await tempDir("turbotunnel-unexecutable-path-");
    await writeFile(join(binDir, "vercel"), "not executable\n", { mode: 0o644 });

    const error = await withPath(binDir, () =>
      runVercel(
        Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.requireInstalled;
        }).pipe(Effect.flip),
      ),
    );

    expect(error._tag).toBe("VercelCliFailed");
    if (error._tag !== "VercelCliFailed") {
      throw new Error("Expected VercelCliFailed");
    }
    expect(error.failure._tag).toBe("SpawnFailed");
    expect("exitCode" in error.failure).toBe(false);
  });

  test("currentAccount trims vercel whoami output", async () => {
    const fake = await fakeVercel(`
if (command === "whoami") {
  console.log("demo-user");
  process.exit(0);
}
process.exit(1);
`);

    const account = await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      return yield* vercel.currentAccount;
    })));

    expect(account).toBe("demo-user");
    expect(await readCalls(fake.callsPath)).toEqual([
      expect.objectContaining({ argv: ["whoami"] }),
    ]);
  });

  test("linkProject passes cwd and project args", async () => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command.startsWith("link ")) {
  process.exit(0);
}
process.exit(1);
`);

    await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      yield* vercel.linkProject(workspace, "demo-turbotunnel");
    })));

    expect(await readCalls(fake.callsPath)).toEqual([
      {
        argv: ["link", "--yes", "--project", "demo-turbotunnel"],
        cwd: workspace,
        stdin: "",
      },
    ]);
  });

  test("setProductionEnv sends values with a trailing newline", async () => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command.startsWith("env update ")) {
  process.exit(0);
}
process.exit(1);
`);

    await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      yield* vercel.setProductionEnv(workspace, "TURBOTUNNEL_BASE_DOMAIN", "{slug}.example.com");
    })));

    expect(await readCalls(fake.callsPath)).toEqual([
      {
        argv: ["env", "update", "TURBOTUNNEL_BASE_DOMAIN", "production"],
        cwd: workspace,
        stdin: "{slug}.example.com\n",
      },
    ]);
  });

  test("setProductionEnv falls back to env add when env update fails", async () => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command.startsWith("env update ")) {
  console.error("missing variable");
  process.exit(1);
}
if (command.startsWith("env add ")) {
  process.exit(0);
}
process.exit(1);
`);

    await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      yield* vercel.setProductionEnv(
        workspace,
        "TURBOTUNNEL_RELAY_SECRET",
        Redacted.make("secret-value", { label: "relay-secret" }),
      );
    })));

    expect(await readCalls(fake.callsPath)).toEqual([
      {
        argv: ["env", "update", "TURBOTUNNEL_RELAY_SECRET", "production"],
        cwd: workspace,
        stdin: "secret-value\n",
      },
      {
        argv: ["env", "add", "TURBOTUNNEL_RELAY_SECRET", "production"],
        cwd: workspace,
        stdin: "secret-value\n",
      },
    ]);
  });

  test("addDomain failures include Vercel output", async () => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command.startsWith("domains add ")) {
  console.error("domain not verified");
  process.exit(1);
}
process.exit(0);
`);

    const error = await withPathPrefix(fake.binDir, () =>
      runVercel(Effect.gen(function* () {
        const vercel = yield* VercelCli;
        return yield* vercel.addDomain(workspace, "*.tunnel.example.com", "demo-turbotunnel");
      }).pipe(Effect.flip)),
    );

    expect(error._tag).toBe("VercelCliFailed");
    if (error._tag !== "VercelCliFailed") {
      throw new Error("Expected VercelCliFailed");
    }
    expect(error.failure).toEqual({ _tag: "NonZeroExit", exitCode: 1 });
    expect(error.message).toContain("Failed to add the gateway domain");
    expect(error.message).toContain("Vercel output:");
    expect(error.message).toContain("domain not verified");
  });

  test.each([
    ["deployment.example.com\n", "https://deployment.example.com/"],
    ["https://deployment.example.com\n", "https://deployment.example.com/"],
  ])("deployProduction parses deployment URL from %j", async (stdout, expected) => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command === "deploy --prod --yes") {
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(0);
}
process.exit(1);
`);

    const deploymentUrl = await withPathPrefix(fake.binDir, () => runVercel(Effect.gen(function* () {
      const vercel = yield* VercelCli;
      return yield* vercel.deployProduction(workspace);
    })));

    expect(deploymentUrl).toBe(expected);
  });

  test("deployProduction fails with a typed error when stdout has no deployment URL", async () => {
    const workspace = await tempRealDir("turbotunnel-vercel-workspace-");
    const fake = await fakeVercel(`
if (command === "deploy --prod --yes") {
  console.log("not a deployment url");
  process.exit(0);
}
process.exit(1);
`);

    const error = await withPathPrefix(fake.binDir, () =>
      runVercel(Effect.gen(function* () {
        const vercel = yield* VercelCli;
        return yield* vercel.deployProduction(workspace);
      }).pipe(Effect.flip)),
    );

    expect(error._tag).toBe("DeployOutputParseError");
  });
});

type FakeVercel = {
  readonly binDir: string;
  readonly callsPath: string;
};

type FakeVercelCall = {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin: string;
};

async function fakeVercel(behavior: string): Promise<FakeVercel> {
  const binDir = await tempDir("turbotunnel-vercel-bin-");
  const callsPath = join(binDir, "calls.jsonl");
  const executablePath = join(binDir, "vercel");
  await writeFile(executablePath, fakeVercelScript(behavior), "utf8");
  await chmod(executablePath, 0o755);
  return { binDir, callsPath };
}

function fakeVercelScript(behavior: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const command = argv.join(" ");
let stdin = "";
if (argv[0] === "env") {
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
}
appendFileSync(process.env.TURBOTUNNEL_FAKE_VERCEL_CALLS, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + "\\n");
${behavior}
`;
}

async function readCalls(path: string): Promise<Array<FakeVercelCall>> {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeVercelCall);
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function tempRealDir(prefix: string): Promise<string> {
  return await realpath(await tempDir(prefix));
}

async function withPathPrefix<A>(dir: string, run: () => Promise<A>): Promise<A> {
  const previousPath = process.env.PATH;
  const previousCalls = process.env.TURBOTUNNEL_FAKE_VERCEL_CALLS;
  process.env.PATH = previousPath === undefined ? dir : `${dir}:${previousPath}`;
  process.env.TURBOTUNNEL_FAKE_VERCEL_CALLS = join(dir, "calls.jsonl");
  try {
    return await run();
  } finally {
    restoreEnv("PATH", previousPath);
    restoreEnv("TURBOTUNNEL_FAKE_VERCEL_CALLS", previousCalls);
  }
}

async function withPath<A>(path: string, run: () => Promise<A>): Promise<A> {
  const previousPath = process.env.PATH;
  process.env.PATH = path;
  try {
    return await run();
  } finally {
    restoreEnv("PATH", previousPath);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function runVercel<A, E>(effect: Effect.Effect<A, E, VercelCli>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(VercelCli.live), Effect.provide(NodeServices.layer)),
  );
}
