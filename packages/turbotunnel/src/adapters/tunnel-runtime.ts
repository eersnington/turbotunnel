import { Clock, Context, Effect, Layer, Scope } from "effect";
import { nanoid } from "nanoid";

import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import type { LocalControlError, RuntimeRegistryError } from "../errors.js";
import { runRelayConnection } from "../runtime/relay-connection.js";
import { makeTunnelSession } from "../runtime/tunnel-session.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { LocalControl } from "./local-control.js";
import { RuntimeRegistry } from "./runtime-registry.js";

export type TunnelRuntimeShape = {
  readonly run: <E = never, R = never>(
    config: HttpTunnelConfig,
    beforeConnect?: Effect.Effect<void, E, R>,
  ) => Effect.Effect<never, RuntimeRegistryError | LocalControlError | E, R>;
};

export class TunnelRuntime extends Context.Service<TunnelRuntime, TunnelRuntimeShape>()(
  "turbotunnel/effect/TunnelRuntime",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const control = yield* LocalControl;
      const reporter = yield* TunnelReporter;
      return TunnelRuntime.of({
        run: (config, beforeConnect = Effect.void) =>
          runTunnel(config, beforeConnect, registry, control, reporter),
      });
    }),
  );
}

const runTunnel = <E, R>(
  config: HttpTunnelConfig,
  beforeConnect: Effect.Effect<void, E, R>,
  registry: RuntimeRegistry["Service"],
  control: LocalControl["Service"],
  reporter: TunnelReporter["Service"],
): Effect.Effect<never, RuntimeRegistryError | LocalControlError | E, R> =>
  Effect.scoped(runTunnelSession(config, beforeConnect, registry, control, reporter));

const runTunnelSession = Effect.fn("TunnelRuntime.runSession")(function* <E, R>(
  config: HttpTunnelConfig,
  beforeConnect: Effect.Effect<void, E, R>,
  registry: RuntimeRegistry["Service"],
  control: LocalControl["Service"],
  reporter: TunnelReporter["Service"],
): Effect.fn.Return<never, RuntimeRegistryError | LocalControlError | E, Scope.Scope | R> {
  const startedAtMs = yield* Clock.currentTimeMillis;
  const sessionId = `ses_${nanoid(12)}`;
  const session = yield* makeTunnelSession({
    config,
    sessionId,
    pid: process.pid,
    startedAtMs,
    reporter,
  });
  yield* Effect.addFinalizer(() =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((stoppedAtMs) =>
        reporter.emit({
          _tag: "TunnelStopped",
          summary: session.stoppedSummary(stoppedAtMs),
        }),
      ),
    ),
  );
  const processToken = nanoid(32);
  const controlHandle = yield* control.open({
    sessionId,
    processToken,
    snapshot: session.snapshot,
  });
  yield* registry.register({
    version: 1,
    sessionId,
    pid: process.pid,
    processToken,
    startedAt: startedAtMs,
    controlSocketPath: controlHandle.endpoint,
  });

  yield* beforeConnect;
  yield* reporter.emit({ _tag: "RelaysConnecting" });
  yield* session.relayWorkersStarted;
  yield* Effect.forEach(
    Array.from({ length: config.poolSize }, (_, index) => index),
    (index) => runRelayConnection(config, index, sessionId, session, reporter),
    { concurrency: "unbounded", discard: true },
  );
  return yield* Effect.never;
});
