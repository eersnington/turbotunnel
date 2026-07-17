import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Redacted } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { ProjectConfigStore } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import {
  type HttpCommandInput,
  type TunnelEnvironment,
  resolveTunnelConfig,
} from "../domain/tunnel-config.js";
import { gatewayUrl } from "../domain/tunnel-url.js";
import { CliConfigError, type StartHttpTunnelError } from "../errors.js";
import {
  accessOverrideFromEnvironment,
  resolveAccessPolicy,
  type AccessOverride,
} from "../domain/project-access.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";

export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  input: HttpCommandInput,
  env: TunnelEnvironment,
  options: {
    readonly cwd: string;
    readonly projectName?: string;
    readonly processEnv?: Readonly<Record<string, string | undefined>>;
    readonly accessOverride?: AccessOverride;
  } = { cwd: process.cwd() },
): Effect.fn.Return<
  never,
  StartHttpTunnelError,
  | Entropy
  | LocalConfigStore
  | GatewayStatusChecker
  | TunnelRuntime
  | TunnelReporter
  | ProjectConfigStore
  | ProjectDomain
> {
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const gatewayStatusChecker = yield* GatewayStatusChecker;
  const tunnelRuntime = yield* TunnelRuntime;
  const reporter = yield* TunnelReporter;
  const projectConfig = yield* (yield* ProjectConfigStore).discover(
    options.cwd,
    options.projectName,
  );
  const configuredEnvironmentPort = yield* environmentPort(options.processEnv?.TURBOTUNNEL_PORT);
  const savedConfig = yield* localConfigStore.read;
  const generatedTunnelSlug = yield* entropy.tunnelSlug;
  const environmentSlug = env.TURBOTUNNEL_SLUG;
  const environmentDomain = options.processEnv?.TURBOTUNNEL_DOMAIN;
  const requestedSlug =
    input.slug ??
    (environmentDomain === undefined ? (environmentSlug ?? projectConfig?.slug) : undefined);
  const requestedDomain =
    input.slug === undefined
      ? (environmentDomain ?? (environmentSlug === undefined ? projectConfig?.domain : undefined))
      : undefined;
  const accessPolicy = yield* resolveAccessPolicy({
    configured: projectConfig?.access,
    override:
      options.accessOverride ?? (yield* accessOverrideFromEnvironment(options.processEnv ?? {})),
    password: options.processEnv?.TURBOTUNNEL_PASSWORD,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  const provisionalConfig = yield* resolveTunnelConfig({
    input: {
      ...input,
      port: input.port ?? configuredEnvironmentPort ?? projectConfig?.port,
      slug: requestedSlug,
      publicHost:
        requestedDomain ??
        (requestedSlug === undefined ? undefined : `${requestedSlug}-turbotunnel.vercel.app`),
      accessPolicy,
    },
    env,
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
  const gatewayStatus = yield* gatewayStatusChecker.check(
    new URL(
      "/_turbotunnel/status",
      gatewayUrl({ ...provisionalConfig, slug: savedConfig.slug ?? provisionalConfig.slug }),
    ).toString(),
    Redacted.value(provisionalConfig.relaySecret),
  );
  if (gatewayStatus.status === "running" && gatewayStatus.version !== TURBOTUNNEL_VERSION) {
    return yield* new CliConfigError({
      message: `The deployed gateway is version ${gatewayStatus.version}, but this CLI requires ${TURBOTUNNEL_VERSION}. Run \`tt deploy\` to update the gateway. No domain or tunnel was changed.`,
    });
  }
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
      : yield* (yield* ProjectDomain).reconcile({
          configIdentity: projectConfig?.configPath ?? options.cwd,
          targetName: projectConfig?.name,
          targetPath: projectConfig?.root ?? options.cwd,
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
      ...input,
      port: input.port ?? configuredEnvironmentPort ?? projectConfig?.port,
      slug: domainAssignment?.slug ?? input.slug ?? projectConfig?.slug,
      publicHost: domainAssignment?.domain,
      accessPolicy,
    },
    env,
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
  yield* reporter.emit({
    _tag: "TunnelStarting",
    config,
    launch: { _tag: "ExistingApplication" },
  });
  return yield* tunnelRuntime.run(config);
});

function environmentPort(
  value: string | undefined,
): Effect.Effect<number | undefined, CliConfigError> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!/^\d+$/u.test(value)) {
    return Effect.fail(
      new CliConfigError({
        message: "TURBOTUNNEL_PORT must be an integer from 1 to 65535. No tunnel was started.",
      }),
    );
  }
  const port = Number(value);
  return port >= 1 && port <= 65_535
    ? Effect.succeed(port)
    : Effect.fail(
        new CliConfigError({
          message: "TURBOTUNNEL_PORT must be an integer from 1 to 65535. No tunnel was started.",
        }),
      );
}

export function tunnelEnvironmentFromProcess(env: NodeJS.ProcessEnv): TunnelEnvironment {
  return {
    TURBOTUNNEL_SLUG: env.TURBOTUNNEL_SLUG,
    TURBOTUNNEL_BASE_DOMAIN: env.TURBOTUNNEL_BASE_DOMAIN,
    TURBOTUNNEL_RELAY_DOMAIN: env.TURBOTUNNEL_RELAY_DOMAIN,
    TURBOTUNNEL_RELAY_SECRET: env.TURBOTUNNEL_RELAY_SECRET,
    TURBOTUNNEL_RELAY_URL: env.TURBOTUNNEL_RELAY_URL,
  };
}
