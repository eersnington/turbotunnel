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
};

export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  options: RunCommandOptions = {},
): Effect.fn.Return<void, VercelCommandFailed | VercelCommandNotFound, ChildProcessSpawner> {
  const displayCommand = [command, ...args].join(" ");
  const child = ChildProcess.make(command, args, {
    cwd,
    stdin:
      options.stdin === undefined
        ? "inherit"
        : {
            stream: Stream.fromIterable([Buffer.from(options.stdin, "utf8")]),
            endOnDone: true,
          },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* child.pipe(
        Effect.mapError((cause) => classifySpawnFailure(command, displayCommand, cause, options)),
      );
      return yield* handle.exitCode.pipe(
        Effect.mapError((cause) => classifySpawnFailure(command, displayCommand, cause, options)),
      );
    }),
  );

  if (exitCode !== 0 && options.allowFailure !== true) {
    return yield* new VercelCommandFailed({
      command: displayCommand,
      exitCode,
      message: options.failureMessage ?? `${displayCommand} failed with exit code ${exitCode}.`,
    });
  }
});

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
