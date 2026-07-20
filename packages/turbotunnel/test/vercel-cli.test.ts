import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { VercelCli, type VercelCliOptions } from "../src/adapters/vercel-cli.js";

describe("VercelCli.live", () => {
  it.effect("requireInstalled spawns vercel --version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeVercel(`
if (command === "--version") {
  console.log("vercel 99.0.0");
  process.exit(0);
}
process.exit(1);
`);

        yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          yield* vercel.requireInstalled;
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(yield* readCalls(fake.callsPath)).toEqual([
          expect.objectContaining({ argv: ["--version"] }),
        ]);
      }),
    ),
  );

  it.effect("requireInstalled returns a typed not-found error when vercel is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emptyDir = yield* temporaryDirectory("turbotunnel-empty-path-");
        const error = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.requireInstalled;
        }).pipe(Effect.flip, Effect.provide(vercelLayer({ executable: join(emptyDir, "vercel") })));

        expect(error._tag).toBe("VercelCliNotFound");
        expect(error.message).toContain("Vercel CLI is required");
        expect(error.message).toContain("No gateway or tunnel configuration was changed");
      }),
    ),
  );

  it.effect("requireInstalled reports spawn failures without fabricating an exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binDir = yield* temporaryDirectory("turbotunnel-unexecutable-path-");
        const executable = join(binDir, "vercel");
        yield* Effect.promise(() => writeFile(executable, "not executable\n", { mode: 0o644 }));

        const error = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.requireInstalled;
        }).pipe(Effect.flip, Effect.provide(vercelLayer({ executable })));

        expect(error).toMatchObject({
          _tag: "VercelCliFailed",
          failure: { _tag: "SpawnFailed" },
        });
        if (error._tag === "VercelCliFailed") {
          expect("exitCode" in error.failure).toBe(false);
        }
      }),
    ),
  );

  it.effect("currentAccount trims vercel whoami output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeVercel(`
if (command === "whoami") {
  console.log("demo-user");
  process.exit(0);
}
process.exit(1);
`);

        const account = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.currentAccount;
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(account).toBe("demo-user");
        expect(yield* readCalls(fake.callsPath)).toEqual([
          expect.objectContaining({ argv: ["whoami"] }),
        ]);
      }),
    ),
  );

  it.effect("apiGet requests and parses machine-readable JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeVercel(`
if (command === "api /v9/projects/gateway -X GET --raw") {
  console.log(JSON.stringify({ id: "prj_123", name: "gateway" }));
  process.exit(0);
}
process.exit(1);
`);

        const project = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.apiGet("/v9/projects/gateway");
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(project).toEqual({ id: "prj_123", name: "gateway" });
        expect(yield* readCalls(fake.callsPath)).toEqual([
          expect.objectContaining({
            argv: ["api", "/v9/projects/gateway", "-X", "GET", "--raw"],
          }),
        ]);
      }),
    ),
  );

  it.effect("linkProject passes cwd and project args", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command.startsWith("link ")) {
  process.exit(0);
}
process.exit(1);
`);

        yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          yield* vercel.linkProject(workspace, "demo-turbotunnel", "team_123");
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(yield* readCalls(fake.callsPath)).toEqual([
          {
            argv: ["link", "--yes", "--project", "demo-turbotunnel", "--scope", "team_123"],
            cwd: workspace,
            stdin: "",
          },
        ]);
      }),
    ),
  );

  it.effect("setProductionEnv sends values with a trailing newline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command.startsWith("env update ")) {
  process.exit(0);
}
process.exit(1);
`);

        yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          yield* vercel.setProductionEnv(
            workspace,
            "TURBOTUNNEL_BASE_DOMAIN",
            "{slug}.example.com",
          );
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(yield* readCalls(fake.callsPath)).toEqual([
          {
            argv: ["env", "update", "TURBOTUNNEL_BASE_DOMAIN", "production"],
            cwd: workspace,
            stdin: "{slug}.example.com\n",
          },
        ]);
      }),
    ),
  );

  it.effect("setProductionEnv falls back to env add when env update fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command.startsWith("env update ")) {
  console.error("missing variable");
  process.exit(1);
}
if (command.startsWith("env add ")) {
  process.exit(0);
}
process.exit(1);
`);

        yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          yield* vercel.setProductionEnv(
            workspace,
            "TURBOTUNNEL_RELAY_SECRET",
            Redacted.make("secret-value", { label: "relay-secret" }),
          );
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(yield* readCalls(fake.callsPath)).toEqual([
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
      }),
    ),
  );

  it.effect("addDomain failures include Vercel output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command.startsWith("domains add ")) {
  console.error("domain not verified");
  process.exit(1);
}
process.exit(0);
`);

        const error = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.addDomain(workspace, "*.tunnel.example.com", "demo-turbotunnel");
        }).pipe(Effect.flip, Effect.provide(vercelLayer(fake)));

        expect(error).toMatchObject({
          _tag: "VercelCliFailed",
          failure: { _tag: "NonZeroExit", exitCode: 1 },
        });
        expect(error.message).toContain("Failed to attach the domain");
        expect(error.message).toContain("Vercel output:");
        expect(error.message).toContain("domain not verified");
      }),
    ),
  );

  it.effect("verifyDomain surfaces strict custom-domain verification failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command.startsWith("domains verify ")) {
  console.error("missing required DNS record");
  process.exit(1);
}
process.exit(0);
`);

        const error = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.verifyDomain(workspace, "app.example.com", "gateway");
        }).pipe(Effect.flip, Effect.provide(vercelLayer(fake)));

        expect(error).toMatchObject({
          _tag: "VercelCliFailed",
          failure: { _tag: "NonZeroExit", exitCode: 1 },
        });
        expect(error.message).toContain("attached app.example.com");
        expect(error.message).toContain("missing required DNS record");
        expect(yield* readCalls(fake.callsPath)).toEqual([
          expect.objectContaining({
            argv: [
              "domains",
              "verify",
              "app.example.com",
              "--project",
              "gateway",
              "--strict",
              "--format=json",
              "--non-interactive",
            ],
          }),
        ]);
      }),
    ),
  );

  it.effect.each([
    ["deployment.example.com\n", "https://deployment.example.com/"],
    ["https://deployment.example.com\n", "https://deployment.example.com/"],
  ] as const)("deployProduction parses deployment URL from %j", ([stdout, expected]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
 if (command === "deploy --prod --yes --scope team_123") {
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(0);
}
process.exit(1);
`);

        const deploymentUrl = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.deployProduction(workspace, "team_123");
        }).pipe(Effect.provide(vercelLayer(fake)));

        expect(deploymentUrl).toBe(expected);
      }),
    ),
  );

  it.effect("deployProduction fails with a typed error when stdout has no deployment URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* temporaryRealDirectory("turbotunnel-vercel-workspace-");
        const fake = yield* fakeVercel(`
if (command === "deploy --prod --yes") {
  console.log("not a deployment url");
  process.exit(0);
}
process.exit(1);
`);

        const error = yield* Effect.gen(function* () {
          const vercel = yield* VercelCli;
          return yield* vercel.deployProduction(workspace);
        }).pipe(Effect.flip, Effect.provide(vercelLayer(fake)));

        expect(error._tag).toBe("DeployOutputParseError");
      }),
    ),
  );
});

type FakeVercel = VercelCliOptions & {
  readonly callsPath: string;
};

type FakeVercelCall = {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin: string;
};

const fakeVercel = (behavior: string) =>
  Effect.gen(function* () {
    const binDir = yield* temporaryDirectory("turbotunnel-vercel-bin-");
    const callsPath = join(binDir, "calls.jsonl");
    const executable = join(binDir, "vercel");
    yield* Effect.promise(() => writeFile(executable, fakeVercelScript(behavior), "utf8"));
    yield* Effect.promise(() => chmod(executable, 0o755));
    return {
      executable,
      env: { TURBOTUNNEL_FAKE_VERCEL_CALLS: callsPath },
      callsPath,
    } satisfies FakeVercel;
  });

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

const readCalls = (path: string) =>
  Effect.promise(async () => {
    const content = await readFile(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeVercelCall);
  });

const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );

const temporaryRealDirectory = (prefix: string) =>
  temporaryDirectory(prefix).pipe(Effect.flatMap((path) => Effect.promise(() => realpath(path))));

const vercelLayer = (options: VercelCliOptions) =>
  VercelCli.layer(options).pipe(Layer.provide(NodeServices.layer));
