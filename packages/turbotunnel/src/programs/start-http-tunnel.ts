import { Effect } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { ProjectConfigStore } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import { parseEnvironmentPort } from "../domain/environment-port.js";
import { type HttpCommandInput, type TunnelEnvironment } from "../domain/tunnel-config.js";
import { type StartHttpTunnelError } from "../errors.js";
import { type AccessOverride } from "../domain/project-access.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { resolveProjectTunnel } from "./resolve-project-tunnel.js";

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
  | TunnelRuntime
  | Entropy
  | LocalConfigStore
  | GatewayStatusChecker
  | TunnelReporter
  | ProjectConfigStore
  | ProjectDomain
> {
  const tunnelRuntime = yield* TunnelRuntime;
  const reporter = yield* TunnelReporter;
  const projectConfig = yield* (yield* ProjectConfigStore).discover(
    options.cwd,
    options.projectName,
  );
  const configuredEnvironmentPort = yield* parseEnvironmentPort(
    options.processEnv?.TURBOTUNNEL_PORT,
    "No tunnel was started.",
  );
  const config = yield* resolveProjectTunnel({
    input: {
      ...input,
      port: input.port ?? configuredEnvironmentPort ?? projectConfig?.port,
    },
    env,
    cwd: options.cwd,
    targetPath: projectConfig?.root ?? options.cwd,
    projectConfig,
    processEnv: options.processEnv ?? {},
    accessOverride: options.accessOverride,
  });
  yield* reporter.emit({
    _tag: "TunnelStarting",
    config,
    launch: { _tag: "ExistingApplication" },
  });
  return yield* tunnelRuntime.run(config);
});

export function tunnelEnvironmentFromProcess(env: NodeJS.ProcessEnv): TunnelEnvironment {
  return {
    TURBOTUNNEL_SLUG: env.TURBOTUNNEL_SLUG,
    TURBOTUNNEL_BASE_DOMAIN: env.TURBOTUNNEL_BASE_DOMAIN,
    TURBOTUNNEL_RELAY_DOMAIN: env.TURBOTUNNEL_RELAY_DOMAIN,
    TURBOTUNNEL_RELAY_SECRET: env.TURBOTUNNEL_RELAY_SECRET,
    TURBOTUNNEL_RELAY_URL: env.TURBOTUNNEL_RELAY_URL,
  };
}
