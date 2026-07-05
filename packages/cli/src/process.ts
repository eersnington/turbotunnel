import { Buffer } from "node:buffer";

import { Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { VercelCommandFailed, VercelCommandNotFound } from "./errors.js";

export type RunCommandOptions = {
  readonly stdin?: string;
  readonly allowFailure?: boolean;
  readonly commandNotFoundMessage?: string;
  readonly failureMessage?: string;
  readonly output?: "inherit" | "capture";
  readonly includeOutputOnFailure?: boolean;
};

export type CommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  options: RunCommandOptions = {},
): Effect.fn.Return<
  CommandOutput,
  VercelCommandFailed | VercelCommandNotFound,
  ChildProcessSpawner
> {
  const displayCommand = [command, ...args].join(" ");
  const output = options.output ?? "inherit";
  const child = ChildProcess.make(command, args, {
    cwd,
    stdin:
      options.stdin === undefined
        ? "inherit"
        : {
            stream: Stream.fromIterable([Buffer.from(options.stdin, "utf8")]),
            endOnDone: true,
          },
    stdout: output === "capture" ? "pipe" : "inherit",
    stderr: output === "capture" ? "pipe" : "inherit",
  });
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* child.pipe(
        Effect.mapError((cause) => classifySpawnFailure(command, displayCommand, cause, options)),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          output === "capture" ? collectText(handle.stdout, displayCommand) : Effect.succeed(""),
          output === "capture" ? collectText(handle.stderr, displayCommand) : Effect.succeed(""),
          handle.exitCode.pipe(
            Effect.mapError((cause) =>
              classifySpawnFailure(command, displayCommand, cause, options),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode };
    }),
  );

  if (result.exitCode !== 0 && options.allowFailure !== true) {
    const outputExcerpt =
      output === "capture" && options.includeOutputOnFailure === true
        ? commandOutputExcerpt(result.stderr, result.stdout)
        : "";
    return yield* new VercelCommandFailed({
      command: displayCommand,
      exitCode: result.exitCode,
      message: `${
        options.failureMessage ?? `${displayCommand} failed with exit code ${result.exitCode}.`
      }${outputExcerpt}`,
    });
  }

  return { stdout: result.stdout, stderr: result.stderr };
});

function commandOutputExcerpt(stderr: string, stdout: string): string {
  const text = stderr.trim() || stdout.trim();
  if (text.length === 0) {
    return "";
  }

  const excerpt = text.length <= 2_000 ? text : `${text.slice(0, 2_000)}...`;
  return `\n\nVercel output:\n${excerpt}`;
}

function collectText(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  command: string,
): Effect.Effect<string, VercelCommandFailed> {
  return Stream.mkString(Stream.decodeText(stream)).pipe(
    Effect.mapError(
      (cause) =>
        new VercelCommandFailed({
          command,
          exitCode: 1,
          message: `Unable to read output from ${command}. ${cause.message}`,
        }),
    ),
  );
}

function classifySpawnFailure(
  command: string,
  displayCommand: string,
  cause: PlatformError,
  options: RunCommandOptions,
): VercelCommandNotFound | VercelCommandFailed {
  if (cause.reason._tag === "NotFound") {
    return new VercelCommandNotFound({
      command,
      cause,
      message:
        options.commandNotFoundMessage ??
        `Required executable \`${command}\` was not found in PATH. Install it and retry.`,
    });
  }

  return new VercelCommandFailed({
    command: displayCommand,
    exitCode: 1,
    message: options.failureMessage ?? `${displayCommand} could not be started. ${cause.message}`,
  });
}
