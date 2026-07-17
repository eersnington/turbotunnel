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
import { parseEnvironmentPort } from "../domain/environment-port.js";
import { assertCompatibleGateway } from "../domain/gateway-compat.js";
import { resolveTunnelConfig, type TunnelEnvironment } from "../domain/tunnel-config.js";
import { formatProcessCommand, redactShellCommand } from "../domain/process-command.js";
import { publicTunnelHost, publicTunnelUrl } from "../domain/tunnel-url.js";
import {
  accessOverrideFromEnvironment,
  resolveAccessPolicy,
  type AccessOverride,
} from "../domain/project-access.js";
import { CliConfigError, DevServerReadinessTimeout, type StartDevError } from "../errors.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";

const DEV_SERVER_READINESS_TIMEOUT_SECONDS = 60;

export const startDev = Effect.fn("startDev")(function* (options: {
  readonly input: DevCommandInput;
  readonly cwd: string;
  readonly env: TunnelEnvironment;
  readonly projectName?: string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
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
  const projectDomain = yield* ProjectDomain;
  const portAllocator = yield* PortAllocator;
  const devProcess = yield* DevProcess;
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const localAppProbe = yield* LocalAppProbe;
  const gatewayStatusChecker = yield* GatewayStatusChecker;
  const tunnelRuntime = yield* TunnelRuntime;
  const reporter = yield* TunnelReporter;

  const projectConfig = yield* projectConfigStore.discover(options.cwd, options.projectName);
  const project = yield* projectDiscovery.discover(projectConfig?.root ?? options.cwd);
  const environmentPort = yield* parseEnvironmentPort(
    options.processEnv?.TURBOTUNNEL_PORT,
    "No child process or tunnel was started.",
  );
  const customPort =
    options.input.port === undefined ? yield* customCommandPort(options.input.command) : undefined;
  const port =
    options.input.port ??
    customPort ??
    environmentPort ??
    projectConfig?.port ??
    (yield* portAllocator.freePort);
  const launch = yield* resolveDevLaunch(
    project,
    options.input,
    port,
    options.processEnv?.TURBOTUNNEL_DEV ?? projectConfig?.dev,
  );
  const savedConfig = yield* localConfigStore.read;
  const generatedTunnelSlug = yield* entropy.tunnelSlug;
  const environmentSlug = options.env.TURBOTUNNEL_SLUG;
  const environmentDomain = options.processEnv?.TURBOTUNNEL_DOMAIN;
  const requestedSlug =
    environmentDomain === undefined ? (environmentSlug ?? projectConfig?.slug) : undefined;
  const requestedDomain =
    environmentDomain ?? (environmentSlug === undefined ? projectConfig?.domain : undefined);
  const accessPolicy = yield* resolveAccessPolicy({
    configured: projectConfig?.access,
    override:
      options.accessOverride ?? (yield* accessOverrideFromEnvironment(options.processEnv ?? {})),
    password: options.processEnv?.TURBOTUNNEL_PASSWORD,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  const provisionalConfig = yield* resolveTunnelConfig({
    input: {
      port,
      host: "localhost",
      slug: requestedSlug,
      publicHost:
        requestedDomain ??
        (requestedSlug === undefined ? undefined : `${requestedSlug}-turbotunnel.vercel.app`),
      accessPolicy,
    },
    env: options.env,
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
  yield* assertCompatibleGateway(gatewayStatusChecker, provisionalConfig, savedConfig.slug);
  yield* expandProjectEnvironment(
    projectConfig?.env ?? {},
    {
      TURBOTUNNEL_URL: publicTunnelUrl(provisionalConfig),
      TURBOTUNNEL_HOST: publicTunnelHost(provisionalConfig),
      TURBOTUNNEL_SLUG: provisionalConfig.slug,
    },
    options.processEnv ?? {},
  );
  const generatedDeploySlug = yield* entropy.deploySlug;
  if (projectConfig !== undefined || requestedDomain !== undefined) {
    yield* reporter.emit({
      _tag: "DomainConfiguring",
      hostname: requestedDomain ?? `${requestedSlug ?? generatedDeploySlug}-turbotunnel.vercel.app`,
    });
  }
  const domainAssignment =
    projectConfig === undefined && requestedDomain === undefined
      ? undefined
      : yield* projectDomain.reconcile({
          configIdentity: projectConfig?.configPath ?? options.cwd,
          targetName: projectConfig?.name,
          targetPath: project.root,
          requestedSlug,
          requestedDomain,
          gateway: {
            project: savedConfig.project,
            teamId: savedConfig.teamId,
            projectId: savedConfig.projectId,
          },
          generatedDeploySlug,
        });
  const config = yield* resolveTunnelConfig({
    input: {
      port,
      host: "localhost",
      slug: domainAssignment?.slug ?? projectConfig?.slug,
      publicHost: domainAssignment?.domain,
      accessPolicy,
    },
    env: options.env,
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
  const publicUrl = publicTunnelUrl(config);
  const command =
    launch.shell === true
      ? redactShellCommand(launch.executable)
      : formatProcessCommand(launch.executable, launch.args);
  const mappedEnvironment = yield* expandProjectEnvironment(
    projectConfig?.env ?? {},
    {
      TURBOTUNNEL_URL: publicUrl,
      TURBOTUNNEL_HOST: publicTunnelHost(config),
      TURBOTUNNEL_SLUG: config.slug,
    },
    options.processEnv ?? {},
  );

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
        env: {
          ...mappedEnvironment,
          PORT: String(port),
          TURBOTUNNEL_URL: publicUrl,
          TURBOTUNNEL_HOST: publicTunnelHost(config),
          TURBOTUNNEL_SLUG: config.slug,
        },
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

const PLACEHOLDER_PATTERN = /\$\{(TURBOTUNNEL_[A-Z0-9_]+)\}/gu;

function expandProjectEnvironment(
  configured: Readonly<Record<string, string>>,
  tunnel: Readonly<Record<"TURBOTUNNEL_URL" | "TURBOTUNNEL_HOST" | "TURBOTUNNEL_SLUG", string>>,
  processEnvironment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Readonly<Record<string, string>>, CliConfigError> {
  const result: Record<string, string> = {};
  for (const [name, template] of Object.entries(configured)) {
    if (processEnvironment[name] !== undefined) continue;
    let invalid: string | undefined;
    const value = template.replace(PLACEHOLDER_PATTERN, (_match, placeholder: string) => {
      if (placeholder in tunnel) return tunnel[placeholder as keyof typeof tunnel];
      invalid = placeholder;
      return "";
    });
    if (invalid !== undefined) {
      return Effect.fail(
        new CliConfigError({
          message: `Unknown Turbotunnel placeholder \${${invalid}} in environment variable ${name}. Supported placeholders are \${TURBOTUNNEL_URL}, \${TURBOTUNNEL_HOST}, and \${TURBOTUNNEL_SLUG}. No child process or tunnel was started.`,
        }),
      );
    }
    result[name] = value;
  }
  return Effect.succeed(result);
}
