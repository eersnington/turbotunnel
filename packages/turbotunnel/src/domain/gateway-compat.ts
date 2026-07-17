import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Redacted } from "effect";

import type { GatewayStatusChecker } from "../adapters/gateway-status-checker.js";
import { CliConfigError } from "../errors.js";
import type { HttpTunnelConfig } from "./tunnel-config.js";
import { gatewayUrl } from "./tunnel-url.js";

/** Fail when a reachable gateway reports an incompatible protocol version. */
export function assertCompatibleGateway(
  checker: GatewayStatusChecker["Service"],
  config: HttpTunnelConfig,
  savedSlug: string | undefined,
): Effect.Effect<void, CliConfigError> {
  const statusUrl = new URL(
    "/_turbotunnel/status",
    gatewayUrl({ ...config, slug: savedSlug ?? config.slug }),
  ).toString();
  return checker.check(statusUrl, Redacted.value(config.relaySecret)).pipe(
    Effect.flatMap((status) =>
      status.status === "running" && status.version !== TURBOTUNNEL_VERSION
        ? Effect.fail(
            new CliConfigError({
              message: `The deployed gateway is version ${status.version}, but this CLI requires ${TURBOTUNNEL_VERSION}. Run \`tt deploy\` to update the gateway. No domain or tunnel was changed.`,
            }),
          )
        : Effect.void,
    ),
  );
}
