import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { DevProcess } from "../src/adapters/dev-process.js";

describe("DevProcess", () => {
  it.effect("spawns direct argv and preserves a numeric child exit code", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* (yield* DevProcess).spawn({
            executable: process.execPath,
            args: ["-e", "process.exit(Number(process.argv[1]))", "23"],
            cwd: process.cwd(),
            env: {},
          });
          return yield* child.exitCode;
        }),
      );

      expect(exitCode).toBe(23);
    }).pipe(Effect.provide(DevProcess.live)),
  );

  it.effect("maps signal exits to conventional numeric codes", () =>
    Effect.gen(function* () {
      for (const [signal, expected] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const exitCode = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* (yield* DevProcess).spawn({
              executable: process.execPath,
              args: ["-e", `process.kill(process.pid, ${JSON.stringify(signal)})`],
              cwd: process.cwd(),
              env: {},
            });
            return yield* child.exitCode;
          }),
        );
        expect(exitCode).toBe(expected);
      }
    }).pipe(Effect.provide(DevProcess.live)),
  );

  it.effect("cleans up descendants after the process-group leader exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-process-group-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const pidPath = join(root, "descendant.pid");
        const markerPath = join(root, "terminated");
        const readyPath = join(root, "ready");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const script = [
              'const { spawn } = require("node:child_process")',
              'const fs = require("node:fs")',
              `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(markerPath)}, "terminated"); process.exit(0) }); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000)`)}], { stdio: "ignore" })`,
              "child.unref()",
              `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(readyPath)})) { clearInterval(timer); fs.writeFileSync(process.argv[1], String(child.pid)) } }, 5)`,
            ].join(";");
            const child = yield* (yield* DevProcess).spawn({
              executable: process.execPath,
              args: ["-e", script, pidPath],
              cwd: root,
              env: {},
            });
            expect(yield* child.exitCode).toBe(0);
          }),
        ).pipe(Effect.provide(DevProcess.live));

        expect(yield* Effect.promise(() => readFile(markerPath, "utf8"))).toBe("terminated");
      }),
    ),
  );
});
