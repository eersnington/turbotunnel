import { Effect, Option } from "effect";

import {
  GatewayStatusChecker,
  type GatewayStatusCheck,
} from "../adapters/gateway-status-checker.js";
import { LocalControl } from "../adapters/local-control.js";
import { RuntimeRegistry } from "../adapters/runtime-registry.js";
import { renderStatus, type StatusOutput } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import type { StatusError } from "../errors.js";

export type StatusFormat = "terminal" | "json";

export const showStatus = Effect.fn("showStatus")(function* (options: {
  readonly format: StatusFormat;
}): Effect.fn.Return<
  void,
  StatusError,
  RuntimeRegistry | LocalControl | GatewayStatusChecker | CliOutput
> {
  const registry = yield* RuntimeRegistry;
  const control = yield* LocalControl;
  const gatewayChecker = yield* GatewayStatusChecker;
  const output = yield* CliOutput;
  const records = yield* registry.list;
  const queried = yield* Effect.forEach(
    records,
    (record) =>
      control.query(record).pipe(
        Effect.map(Option.some),
        Effect.catchTag("LocalControlError", (error) =>
          error.reason === "temporarily-unavailable"
            ? Effect.succeed(Option.none<TunnelLifecycleSnapshot>())
            : registry.remove(record).pipe(Effect.as(Option.none<TunnelLifecycleSnapshot>())),
        ),
      ),
    { concurrency: 8 },
  );
  const tunnels = queried
    .filter(Option.isSome)
    .map((entry) => entry.value)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  const gateways = yield* checkDistinctGateways(gatewayChecker, tunnels);

  const status: StatusOutput = { tunnels, gateways };
  yield* output.write(renderStatus({ format: options.format, status }));
});

function checkDistinctGateways(
  checker: GatewayStatusChecker["Service"],
  tunnels: ReadonlyArray<TunnelLifecycleSnapshot>,
): Effect.Effect<ReadonlyArray<GatewayStatusCheck>> {
  const urls = [...new Set(tunnels.map((tunnel) => tunnel.gatewayStatusUrl))];
  return Effect.forEach(urls, checker.check, { concurrency: 4 });
}
