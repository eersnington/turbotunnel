import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";

import { DevProcessError } from "../errors.js";
import { formatProcessCommand } from "../domain/process-command.js";

export type DevProcessSpec = {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell?: boolean;
  readonly displayCommand?: string;
};

export type RunningDevProcess = {
  readonly exitCode: Effect.Effect<number, DevProcessError>;
};

export type DevProcessShape = {
  readonly spawn: (
    spec: DevProcessSpec,
  ) => Effect.Effect<RunningDevProcess, DevProcessError, Scope.Scope>;
};

export class DevProcess extends Context.Service<DevProcess, DevProcessShape>()(
  "turbotunnel/effect/DevProcess",
) {
  static readonly live = Layer.succeed(
    this,
    DevProcess.of({ spawn: (spec) => spawnDevProcess(spec) }),
  );
}

const spawnDevProcess = Effect.fn("DevProcess.spawn")(function* (
  spec: DevProcessSpec,
): Effect.fn.Return<RunningDevProcess, DevProcessError, Scope.Scope> {
  const command = spec.displayCommand ?? formatProcessCommand(spec.executable, spec.args);
  const exitCode = yield* Deferred.make<number>();
  const child = yield* startChild(spec, command, exitCode);
  const pid = child.pid;
  if (pid === undefined) {
    return yield* new DevProcessError({
      command,
      operation: "spawn",
      cause: "Child process started without a process identifier.",
      message: `Failed to manage \`${command}\` after it started. Retry the command. No tunnel was started.`,
    });
  }

  yield* Effect.addFinalizer(() =>
    terminateProcessGroup(pid).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not fully stop the managed dev process group.").pipe(
          Effect.annotateLogs({ command, pid, cause }),
        ),
      ),
    ),
  );
  return {
    exitCode: Deferred.await(exitCode).pipe(
      Effect.mapError(
        (cause) =>
          new DevProcessError({
            command,
            operation: "wait",
            cause,
            message: `Failed to read the exit status from \`${command}\`. Turbotunnel stopped managing the dev process and tunnel.`,
          }),
      ),
    ),
  };
});

function startChild(
  spec: DevProcessSpec,
  command: string,
  exitCode: Deferred.Deferred<number>,
): Effect.Effect<ChildProcess, DevProcessError> {
  return Effect.callback((resume) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: "inherit",
      detached: process.platform !== "win32",
      shell: spec.shell ?? false,
    });
    let started = false;
    child.once("error", (cause) => {
      if (!started) {
        resume(
          Effect.fail(
            new DevProcessError({
              command,
              operation: "spawn",
              cause,
              message: `Failed to start \`${command}\` in ${spec.cwd}. Confirm the executable is installed and the dev script works, then retry. No tunnel was started.`,
            }),
          ),
        );
      }
    });
    child.once("spawn", () => {
      started = true;
      resume(Effect.succeed(child));
    });
    child.once("exit", (code, signal) => {
      Deferred.doneUnsafe(exitCode, Exit.succeed(code ?? signalExitCode(signal)));
    });
    return Effect.sync(() => {
      if (child.pid !== undefined) sendSignal(child.pid, "SIGKILL");
    });
  });
}

function terminateProcessGroup(pid: number): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => sendSignal(pid, "SIGTERM"), catch: (cause) => cause });
    yield* waitForProcessGroupExit(pid).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () =>
          Effect.try({ try: () => sendSignal(pid, "SIGKILL"), catch: (cause) => cause }),
      }),
    );
  });
}

const waitForProcessGroupExit = Effect.fn("DevProcess.waitForProcessGroupExit")(function* (
  pid: number,
) {
  while (processGroupExists(pid)) yield* Effect.sleep(50);
});

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    const result = spawnSync("taskkill", args, { stdio: "ignore", shell: false });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 && processGroupExists(pid)) {
      throw new Error(`taskkill exited with status ${result.status ?? "unknown"}`);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if (!isNoSuchProcess(cause)) throw cause;
  }
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") {
    return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      encoding: "utf8",
      shell: false,
    }).stdout.includes(String(pid));
  }
  const processes = spawnSync("ps", ["-axo", "stat=,pgid="], {
    encoding: "utf8",
    shell: false,
  });
  if (processes.status === 0) {
    return processes.stdout.split("\n").some((line) => {
      const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
      return match?.[2] === String(pid) && !match[1]?.startsWith("Z");
    });
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return !isNoSuchProcess(cause);
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 1);
}

function isNoSuchProcess(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
}
