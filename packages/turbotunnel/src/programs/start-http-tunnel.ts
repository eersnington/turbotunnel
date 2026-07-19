import { Effect } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { ProjectConfigStore } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import { type HttpCommandInput } from "../domain/tunnel-config.js";
import { type StartHttpTunnelError } from "../errors.js";
import { type AccessOverride } from "../domain/project-access.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { prepareProjectTunnel } from "./resolve-project-tunnel.js";

export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  input: HttpCommandInput,
  options: {
    readonly cwd: string;
    readonly projectName?: string;
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
  const config = yield* prepareProjectTunnel({
    input: {
      ...input,
      port: input.port ?? projectConfig?.port,
    },
    cwd: options.cwd,
    targetPath: projectConfig?.root ?? options.cwd,
    projectConfig,
    accessOverride: options.accessOverride,
  });
  yield* reporter.emit({
    _tag: "TunnelStarting",
    config,
    launch: { _tag: "ExistingApplication" },
  });
  return yield* tunnelRuntime.run(config);
});
