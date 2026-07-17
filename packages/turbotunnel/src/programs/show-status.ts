import { Clock, Effect, Option, Result } from "effect";

import {
  GatewayStatusChecker,
  type GatewayStatusCheck,
} from "../adapters/gateway-status-checker.js";
import { LocalControl } from "../adapters/local-control.js";
import { RuntimeRegistry } from "../adapters/runtime-registry.js";
import { renderStatus, type StatusOutput } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { RuntimeRecord, TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import type { LocalControlError, RuntimeRegistryError, StatusError } from "../errors.js";

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
    (record) => queryRecord(control, registry, record),
    { concurrency: 8 },
  );
  const tunnels = queried
    .filter(Option.isSome)
    .map((entry) => entry.value)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  const gateways = yield* checkDistinctGateways(gatewayChecker, tunnels);
  const generatedAt = yield* Clock.currentTimeMillis;

  const status: StatusOutput = { generatedAt, tunnels, gateways };
  yield* output.write(renderStatus({ format: options.format, status }));
});

function queryRecord(
  control: LocalControl["Service"],
  registry: RuntimeRegistry["Service"],
  record: RuntimeRecord,
): Effect.Effect<Option.Option<TunnelLifecycleSnapshot>, LocalControlError | RuntimeRegistryError> {
  return Effect.gen(function* () {
    const result = yield* control.query(record).pipe(Effect.result);
    if (Result.isSuccess(result)) return Option.some(result.success);
    if (result.failure.reason === "temporarily-unavailable") return yield* result.failure;
    yield* registry.remove(record);
    return Option.none();
  });
}

function checkDistinctGateways(
  checker: GatewayStatusChecker["Service"],
  tunnels: ReadonlyArray<TunnelLifecycleSnapshot>,
): Effect.Effect<ReadonlyArray<GatewayStatusCheck>> {
  const urls = [...new Set(tunnels.map((tunnel) => tunnel.gatewayStatusUrl))];
  return Effect.forEach(urls, (url) => checker.check(url), { concurrency: 4 });
}
