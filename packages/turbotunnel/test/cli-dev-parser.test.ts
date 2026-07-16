import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { DevProcess } from "../src/adapters/dev-process.js";
import { decodeDevArguments, prepareCliArgv } from "../src/cli/argv.js";

describe("tt dev argv parsing", () => {
  it.effect("preserves every child argument after -- without a shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-cli-dev-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const outputPath = join(root, "argv.json");
        const childPath = join(root, "child.mjs");
        yield* Effect.promise(() =>
          writeFile(
            childPath,
            `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(process.argv.slice(2))); process.exit(27);`,
          ),
        );

        let childExitCode: number | undefined;
        const dev = Command.make(
          "dev",
          { command: Argument.string("command").pipe(Argument.variadic()) },
          ({ command }) =>
            Effect.gen(function* () {
              const [executable, ...args] = decodeDevArguments(command);
              if (executable === undefined) return;
              const child = yield* (yield* DevProcess).spawn({
                executable,
                args,
                cwd: root,
                env: {},
              });
              childExitCode = yield* child.exitCode;
            }),
        );
        const rootCommand = Command.make("turbotunnel").pipe(Command.withSubcommands([dev]));
        yield* Command.runWith(rootCommand, { version: "test" })(
          prepareCliArgv([
            "dev",
            "--",
            process.execPath,
            childPath,
            "--host",
            "0.0.0.0",
            "--strictPort",
            "-x",
            "value",
          ]),
        );

        expect(childExitCode).toBe(27);
        expect(JSON.parse(yield* Effect.promise(() => readFile(outputPath, "utf8")))).toEqual([
          "--host",
          "0.0.0.0",
          "--strictPort",
          "-x",
          "value",
        ]);
      }).pipe(Effect.provide(DevProcess.live), Effect.provide(NodeServices.layer)),
    ),
  );
});
