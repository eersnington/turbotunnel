import { Clock, Context, Effect, Layer, Scope } from "effect";
import { nanoid } from "nanoid";

import { renderTunnel } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import { runRelayConnection, type TunnelSessionStats } from "../runtime/relay-connection.js";
import { TunnelReporter, type TunnelReporterShape } from "../runtime/tunnel-reporter.js";

export type TunnelRuntimeShape = {
  readonly run: (config: HttpTunnelConfig) => Effect.Effect<never>;
};

export class TunnelRuntime extends Context.Service<TunnelRuntime, TunnelRuntimeShape>()(
  "turbotunnel/effect/TunnelRuntime",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const output = yield* CliOutput;
      const reporter: TunnelReporterShape = {
        starting: (config) => output.write(renderTunnel({ _tag: "Starting", config })),
        ready: () => output.write(renderTunnel({ _tag: "Ready" })),
        stopped: (summary) => output.write(renderTunnel({ _tag: "Stopped", summary })),
        warning: (message) => output.write(renderTunnel({ _tag: "Warning", message })),
      };
      return TunnelRuntime.of({
        run: (config) => runTunnel(config).pipe(Effect.provideService(TunnelReporter, reporter)),
      });
    }),
  );
}

const runTunnel = (config: HttpTunnelConfig): Effect.Effect<never, never, TunnelReporter> =>
  Effect.scoped(runTunnelSession(config));

const runTunnelSession = Effect.fn("TunnelRuntime.runSession")(function* (
  config: HttpTunnelConfig,
): Effect.fn.Return<never, never, TunnelReporter | Scope.Scope> {
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
    readyPrinted: false,
  };

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

  const sessionId = `ses_${nanoid(12)}`;
  yield* Effect.forEach(
    Array.from({ length: config.poolSize }, (_, index) => index),
    (index) => runRelayConnection(config, index, sessionId, stats),
    { concurrency: "unbounded", discard: true },
  );
  return yield* Effect.never;
});
