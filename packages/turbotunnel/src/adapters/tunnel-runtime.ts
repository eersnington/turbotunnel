import { Clock, Context, Effect, Layer, Scope } from "effect";
import { nanoid } from "nanoid";

import { renderTunnel } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import type { TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import { gatewayUrl, publicTunnelUrl } from "../domain/tunnel-url.js";
import type { LocalControlError, RuntimeRegistryError } from "../errors.js";
import { runRelayConnection, type TunnelSessionStats } from "../runtime/relay-connection.js";
import { TunnelReporter, type TunnelReporterShape } from "../runtime/tunnel-reporter.js";
import { LocalControl } from "./local-control.js";
import { RuntimeRegistry } from "./runtime-registry.js";

export type TunnelRuntimeShape = {
  readonly run: <E = never, R = never>(
    config: HttpTunnelConfig,
    beforeConnect?: Effect.Effect<void, E, R>,
  ) => Effect.Effect<never, RuntimeRegistryError | LocalControlError | E, R>;
  readonly snapshot: Effect.Effect<TunnelLifecycleSnapshot | undefined>;
};

export class TunnelRuntime extends Context.Service<TunnelRuntime, TunnelRuntimeShape>()(
  "turbotunnel/effect/TunnelRuntime",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const output = yield* CliOutput;
      const registry = yield* RuntimeRegistry;
      const control = yield* LocalControl;
      let currentSnapshot: (() => TunnelLifecycleSnapshot) | undefined;
      const reporter: TunnelReporterShape = {
        starting: (config) => output.write(renderTunnel({ _tag: "Starting", config })),
        ready: () => output.write(renderTunnel({ _tag: "Ready" })),
        stopped: (summary) => output.write(renderTunnel({ _tag: "Stopped", summary })),
        warning: (message) => output.write(renderTunnel({ _tag: "Warning", message })),
      };
      return TunnelRuntime.of({
        run: (config, beforeConnect = Effect.void) =>
          runTunnel(config, beforeConnect, registry, control, (snapshot) => {
            currentSnapshot = snapshot;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                currentSnapshot = undefined;
              }),
            ),
            Effect.provideService(TunnelReporter, reporter),
          ),
        snapshot: Effect.sync(() => currentSnapshot?.()),
      });
    }),
  );
}

const runTunnel = <E, R>(
  config: HttpTunnelConfig,
  beforeConnect: Effect.Effect<void, E, R>,
  registry: RuntimeRegistry["Service"],
  control: LocalControl["Service"],
  setSnapshot: (snapshot: () => TunnelLifecycleSnapshot) => void,
): Effect.Effect<never, RuntimeRegistryError | LocalControlError | E, TunnelReporter | R> =>
  Effect.scoped(runTunnelSession(config, beforeConnect, registry, control, setSnapshot));

const runTunnelSession = Effect.fn("TunnelRuntime.runSession")(function* <E, R>(
  config: HttpTunnelConfig,
  beforeConnect: Effect.Effect<void, E, R>,
  registry: RuntimeRegistry["Service"],
  control: LocalControl["Service"],
  setSnapshot: (snapshot: () => TunnelLifecycleSnapshot) => void,
): Effect.fn.Return<
  never,
  RuntimeRegistryError | LocalControlError | E,
  TunnelReporter | Scope.Scope | R
> {
  const reporter = yield* TunnelReporter;
  const startedAtMs = yield* Clock.currentTimeMillis;
  const stats: TunnelSessionStats = {
    startedAtMs,
    relayConnects: 0,
    relayCloses: 0,
    relayErrors: 0,
    reconnects: 0,
    framesReceived: 0,
    framesSent: 0,
    invalidFrames: 0,
    httpRequests: 0,
    httpResponses: 0,
    webSocketsOpened: 0,
    webSocketsClosed: 0,
    activeRelayConnections: 0,
    relayWorkersStarted: false,
    reachedConfiguredPool: false,
    readyPrinted: false,
  };

  const sessionId = `ses_${nanoid(12)}`;
  const snapshot = () => makeSnapshot(config, sessionId, stats);
  setSnapshot(snapshot);
  const processToken = nanoid(32);
  const controlHandle = yield* control.open({ sessionId, processToken, snapshot });
  yield* registry.register({
    version: 1,
    sessionId,
    pid: process.pid,
    processToken,
    startedAt: startedAtMs,
    slug: config.slug,
    publicUrl: publicTunnelUrl(config),
    localUrl: `http://${config.target.host}:${config.target.port}`,
    controlSocketPath: controlHandle.endpoint,
  });

  yield* beforeConnect;
  yield* reporter.starting(config);
  yield* Effect.addFinalizer(() =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((stoppedAtMs) =>
        reporter.stopped({
          durationSeconds: Math.max(0, Math.round((stoppedAtMs - stats.startedAtMs) / 1000)),
          httpRequests: stats.httpRequests,
          webSocketsOpened: stats.webSocketsOpened,
        }),
      ),
    ),
  );

  stats.relayWorkersStarted = true;
  yield* Effect.forEach(
    Array.from({ length: config.poolSize }, (_, index) => index),
    (index) => runRelayConnection(config, index, sessionId, stats),
    { concurrency: "unbounded", discard: true },
  );
  return yield* Effect.never;
});

function makeSnapshot(
  config: HttpTunnelConfig,
  sessionId: string,
  stats: TunnelSessionStats,
): TunnelLifecycleSnapshot {
  const gateway = gatewayUrl(config);
  return {
    version: 1,
    sessionId,
    pid: process.pid,
    state: !stats.relayWorkersStarted
      ? "starting"
      : stats.activeRelayConnections === config.poolSize
        ? "ready"
        : stats.reachedConfiguredPool
          ? "reconnecting"
          : "connecting",
    startedAtMs: stats.startedAtMs,
    publicUrl: publicTunnelUrl(config),
    localUrl: `http://${config.target.host}:${config.target.port}`,
    gatewayStatusUrl: new URL("/_turbotunnel/status", gateway).toString(),
    configuredRelays: config.poolSize,
    connectedRelays: stats.activeRelayConnections,
    relayConnects: stats.relayConnects,
    relayCloses: stats.relayCloses,
    relayErrors: stats.relayErrors,
    reconnects: stats.reconnects,
    framesReceived: stats.framesReceived,
    framesSent: stats.framesSent,
    invalidFrames: stats.invalidFrames,
    httpRequests: stats.httpRequests,
    httpResponses: stats.httpResponses,
    webSocketsOpened: stats.webSocketsOpened,
    webSocketsClosed: stats.webSocketsClosed,
  };
}
