import { Effect } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { type ProjectSelection } from "../adapters/project-config-store.js";
import { ProjectDomain } from "../adapters/project-domain.js";
import { assertCompatibleGateway } from "../domain/gateway-compat.js";
import { type AccessOverride, resolveAccessPolicy } from "../domain/project-access.js";
import { type HttpCommandInput, resolveTunnelConfig } from "../domain/tunnel-config.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";

/** Validates gateway access and reconciles any project-owned domain before tunneling. */
export const prepareProjectTunnel = Effect.fn("prepareProjectTunnel")(function* (options: {
  readonly input: HttpCommandInput;
  readonly cwd: string;
  readonly targetPath: string;
  readonly projectConfig: ProjectSelection | undefined;
  readonly accessOverride?: AccessOverride;
}) {
  const entropy = yield* Entropy;
  const savedConfig = yield* (yield* LocalConfigStore).read;
  const generatedTunnelSlug = yield* entropy.tunnelSlug;
  const requestedSlug = options.input.slug ?? options.projectConfig?.slug;
  const requestedDomain =
    options.input.slug === undefined ? options.projectConfig?.domain : undefined;
  const access = yield* resolveAccessPolicy({
    configured: options.projectConfig?.access,
    override: options.accessOverride,
    generatedPassword: yield* entropy.accessPassword,
  });
  const provisionalConfig = yield* resolveTunnelConfig({
    input: {
      ...options.input,
      slug: requestedSlug,
      publicHost:
        requestedDomain ??
        (requestedSlug === undefined ? undefined : `${requestedSlug}-turbotunnel.vercel.app`),
      accessPolicy: access.policy,
    },
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
  const config = yield* resolveTunnelConfig({
    input: {
      ...options.input,
      slug: domainAssignment?.slug ?? options.input.slug ?? options.projectConfig?.slug,
      publicHost: domainAssignment?.domain,
      accessPolicy: access.policy,
    },
    savedConfig,
    generatedSlug: generatedTunnelSlug,
  });
  return { config, password: access.password };
});
