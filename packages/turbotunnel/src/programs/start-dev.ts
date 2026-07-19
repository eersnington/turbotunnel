import { Effect } from "effect";

import { DevProcess } from "../adapters/dev-process.js";
import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { ProjectConfigStore } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import { formatProcessCommand } from "../domain/process-command.js";
import { type AccessOverride } from "../domain/project-access.js";
import { type StartDevError } from "../errors.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { prepareProjectTunnel } from "./resolve-project-tunnel.js";

export type DevCommandInput = {
  readonly port?: number;
  readonly command: ReadonlyArray<string>;
};

/** Opens a project tunnel and optionally supervises the exact child argv supplied by the user. */
export const startDev = Effect.fn("startDev")(function* (options: {
  readonly input: DevCommandInput;
  readonly cwd: string;
  readonly projectName?: string;
  readonly accessOverride?: AccessOverride;
}): Effect.fn.Return<
  number,
  StartDevError,
  | ProjectConfigStore
  | ProjectDomain
  | DevProcess
  | Entropy
  | LocalConfigStore
  | GatewayStatusChecker
  | TunnelRuntime
  | TunnelReporter
> {
  const projectConfig = yield* (yield* ProjectConfigStore).discover(
    options.cwd,
    options.projectName,
  );
  const prepared = yield* prepareProjectTunnel({
    input: {
      port: options.input.port ?? projectConfig?.port,
      host: "localhost",
    },
    cwd: options.cwd,
    targetPath: projectConfig?.configRoot ?? options.cwd,
    projectConfig,
    accessOverride: options.accessOverride,
  });
  const [executable, ...args] = options.input.command;
  if (executable === undefined) {
    const reporter = yield* TunnelReporter;
    if (prepared.password !== undefined) {
      yield* reporter.emit({ _tag: "AccessPasswordReady", password: prepared.password });
    }
    yield* reporter.emit({
      _tag: "TunnelStarting",
      config: prepared.config,
      launch: { _tag: "ExistingApplication" },
    });
    return yield* (yield* TunnelRuntime).run(prepared.config);
  }

  const command = formatProcessCommand(executable, args);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const reporter = yield* TunnelReporter;
      if (prepared.password !== undefined) {
        yield* reporter.emit({ _tag: "AccessPasswordReady", password: prepared.password });
      }
      yield* reporter.emit({
        _tag: "TunnelStarting",
        config: prepared.config,
        launch: { _tag: "ManagedProcess", command, directory: options.cwd },
      });
      yield* reporter.emit({ _tag: "DevelopmentOutputStarting" });
      const child = yield* (yield* DevProcess).spawn({
        executable,
        args,
        cwd: options.cwd,
        env: {},
        displayCommand: command,
      });
      const childExit = child.exitCode.pipe(
        Effect.map((exitCode) => ({ _tag: "Exited" as const, exitCode })),
      );
      const result = yield* Effect.raceFirst(
        (yield* TunnelRuntime).run(prepared.config),
        childExit,
      );
      return result.exitCode;
    }),
  );
});
