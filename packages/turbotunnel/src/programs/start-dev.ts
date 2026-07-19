import { Effect } from "effect";

import { DevProcess } from "../adapters/dev-process.js";
import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalAppProbe } from "../adapters/local-app-probe.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { PortAllocator } from "../adapters/port-allocator.js";
import { ProjectConfigStore } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { ProjectDiscovery } from "../adapters/project-discovery.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import {
  customCommandPort,
  type DevCommandInput,
  resolveDevLaunch,
} from "../domain/dev-project.js";
import { formatProcessCommand, redactShellCommand } from "../domain/process-command.js";
import { type AccessOverride } from "../domain/project-access.js";
import { DevServerReadinessTimeout, type StartDevError } from "../errors.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { prepareProjectTunnel } from "./resolve-project-tunnel.js";

const DEV_SERVER_READINESS_TIMEOUT_SECONDS = 60;

export const startDev = Effect.fn("startDev")(function* (options: {
  readonly input: DevCommandInput;
  readonly cwd: string;
  readonly projectName?: string;
  readonly accessOverride?: AccessOverride;
}): Effect.fn.Return<
  number,
  StartDevError,
  | ProjectDiscovery
  | ProjectConfigStore
  | ProjectDomain
  | PortAllocator
  | DevProcess
  | Entropy
  | LocalConfigStore
  | LocalAppProbe
  | GatewayStatusChecker
  | TunnelRuntime
  | TunnelReporter
> {
  const projectDiscovery = yield* ProjectDiscovery;
  const projectConfigStore = yield* ProjectConfigStore;
  const portAllocator = yield* PortAllocator;
  const devProcess = yield* DevProcess;
  const localAppProbe = yield* LocalAppProbe;
  const tunnelRuntime = yield* TunnelRuntime;
  const reporter = yield* TunnelReporter;

  const projectConfig = yield* projectConfigStore.discover(options.cwd, options.projectName);
  const project = yield* projectDiscovery.discover(projectConfig?.root ?? options.cwd);
  const customPort =
    options.input.port === undefined ? yield* customCommandPort(options.input.command) : undefined;
  const port =
    options.input.port ?? customPort ?? projectConfig?.port ?? (yield* portAllocator.freePort);
  const launch = yield* resolveDevLaunch(project, options.input, port, projectConfig?.dev);
  const config = yield* prepareProjectTunnel({
    input: {
      port,
      host: "localhost",
    },
    cwd: options.cwd,
    targetPath: project.root,
    projectConfig,
    accessOverride: options.accessOverride,
  });
  const command =
    launch.shell === true
      ? redactShellCommand(launch.executable)
      : formatProcessCommand(launch.executable, launch.args);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* reporter.emit({
        _tag: "TunnelStarting",
        config,
        launch: { _tag: "ManagedProcess", command, directory: project.root },
      });
      yield* reporter.emit({ _tag: "LocalApplicationWaiting", target: config.target });
      yield* reporter.emit({ _tag: "DevelopmentOutputStarting" });
      const child = yield* devProcess.spawn({
        executable: launch.executable,
        args: launch.args,
        cwd: project.root,
        env: {},
        shell: launch.shell,
        displayCommand: command,
      });
      const childExit = child.exitCode.pipe(
        Effect.map((exitCode) => ({ _tag: "Exited" as const, exitCode })),
      );
      const readiness = localAppProbe.waitUntilReachable(config.target).pipe(
        Effect.timeoutOrElse({
          duration: `${DEV_SERVER_READINESS_TIMEOUT_SECONDS} seconds`,
          orElse: () =>
            Effect.fail(
              new DevServerReadinessTimeout({
                host: config.target.host,
                port: config.target.port,
                timeoutSeconds: DEV_SERVER_READINESS_TIMEOUT_SECONDS,
                message: `Dev server did not become reachable at http://${config.target.host}:${config.target.port} within ${DEV_SERVER_READINESS_TIMEOUT_SECONDS} seconds. Check the child output and its host/port settings, then retry. The child process and tunnel were stopped.`,
              }),
            ),
        }),
        Effect.andThen(reporter.emit({ _tag: "LocalApplicationReady" })),
      );
      const result = yield* Effect.raceFirst(tunnelRuntime.run(config, readiness), childExit);
      return result.exitCode;
    }),
  );
});
