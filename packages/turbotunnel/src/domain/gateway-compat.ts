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
    Effect.flatMap((status) => {
      if (status.status === "unreachable") return Effect.void;
      if (status.status === "running" && status.version === TURBOTUNNEL_VERSION) return Effect.void;

      const detail =
        status.status === "running"
          ? `The deployed gateway is version ${status.version}, but this CLI requires ${TURBOTUNNEL_VERSION}.`
          : status.status === "rejected"
            ? `The gateway status endpoint rejected the request with HTTP ${status.statusCode}.`
            : `The gateway status endpoint returned an invalid ${status.reason === "too-large" ? "oversized" : "malformed"} response.`;
      return Effect.fail(
        new CliConfigError({
          message: `${detail} Run \`tt deploy\` to restore a compatible gateway. No domain or tunnel was changed.`,
        }),
      );
    }),
  );
}
