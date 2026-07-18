import { Effect } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { type ProjectSelection } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { assertCompatibleGateway } from "../domain/gateway-compat.js";
import {
  accessOverrideFromEnvironment,
  type AccessOverride,
  resolveAccessPolicy,
} from "../domain/project-access.js";
import {
  type HttpCommandInput,
  resolveTunnelConfig,
  type TunnelEnvironment,
} from "../domain/tunnel-config.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";

export const resolveProjectTunnel = Effect.fn("resolveProjectTunnel")(function* (options: {
  readonly input: HttpCommandInput;
  readonly env: TunnelEnvironment;
  readonly cwd: string;
  readonly targetPath: string;
  readonly projectConfig: ProjectSelection | undefined;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly accessOverride?: AccessOverride;
}) {
  const entropy = yield* Entropy;
  const savedConfig = yield* (yield* LocalConfigStore).read;
  const generatedTunnelSlug = yield* entropy.tunnelSlug;
  const environmentSlug = options.env.TURBOTUNNEL_SLUG;
  const environmentDomain = options.processEnv.TURBOTUNNEL_DOMAIN;
  const requestedSlug =
    options.input.slug ??
    (environmentDomain === undefined
      ? (environmentSlug ?? options.projectConfig?.slug)
      : undefined);
  const requestedDomain =
    options.input.slug === undefined
      ? (environmentDomain ??
        (environmentSlug === undefined ? options.projectConfig?.domain : undefined))
      : undefined;
  const accessPolicy = yield* resolveAccessPolicy({
    configured: options.projectConfig?.access,
    override: options.accessOverride ?? (yield* accessOverrideFromEnvironment(options.processEnv)),
    password: options.processEnv.TURBOTUNNEL_PASSWORD,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  const provisionalConfig = yield* resolveTunnelConfig({
    input: {
      ...options.input,
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
  yield* assertCompatibleGateway(yield* GatewayStatusChecker, provisionalConfig, savedConfig.slug);

  const generatedDeploySlug = yield* entropy.deploySlug;
  if (options.projectConfig !== undefined || requestedDomain !== undefined) {
    yield* (yield* TunnelReporter).emit({
      _tag: "DomainConfiguring",
      hostname: requestedDomain ?? `${requestedSlug ?? generatedDeploySlug}-turbotunnel.vercel.app`,
    });
  }
  const domainAssignment =
    options.projectConfig === undefined && requestedDomain === undefined
      ? undefined
      : yield* (yield* ProjectDomain).reconcile({
          configIdentity: options.projectConfig?.configPath ?? options.cwd,
          targetName: options.projectConfig?.name,
          targetPath: options.targetPath,
          requestedSlug,
          requestedDomain,
          gateway: {
            project: savedConfig.project,
            teamId: savedConfig.teamId,
            projectId: savedConfig.projectId,
          },
          generatedDeploySlug,
        });
  return yield* resolveTunnelConfig({
    input: {
      ...options.input,
      slug: domainAssignment?.slug ?? options.input.slug ?? options.projectConfig?.slug,
      publicHost: domainAssignment?.domain,
      accessPolicy,
    },
    env: options.env,
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
});
