import { Context, Effect, Layer } from "effect";
import { nanoid } from "nanoid";

import { renderTunnel, type TunnelStoppedSummary } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import { RelayConnection, type TunnelSessionStats } from "../runtime/relay-connection.js";

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
      return TunnelRuntime.of({
        run: (config) =>
          runTunnel(config, {
            starting: (config) => output.write(renderTunnel({ _tag: "Starting", config })),
            ready: () => output.write(renderTunnel({ _tag: "Ready" })),
            stopped: (summary) => output.write(renderTunnel({ _tag: "Stopped", summary })),
            warning: (message) => output.write(renderTunnel({ _tag: "Warning", message })),
          }),
      });
    }),
  );
}

export type TunnelReporter = {
  readonly starting: (config: HttpTunnelConfig) => Effect.Effect<void>;
  readonly ready: () => Effect.Effect<void>;
  readonly stopped: (summary: TunnelStoppedSummary) => Effect.Effect<void>;
  readonly warning: (message: string) => Effect.Effect<void>;
};

function runTunnel(config: HttpTunnelConfig, reporter: TunnelReporter): Effect.Effect<never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const stats: TunnelSessionStats = {
        startedAtMs: Date.now(),
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
        reporter.stopped({
          durationSeconds: Math.max(0, Math.round((Date.now() - stats.startedAtMs) / 1000)),
          httpRequests: stats.httpRequests,
          webSocketsOpened: stats.webSocketsOpened,
        }),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const connections: Array<RelayConnection> = [];
          const sessionId = `ses_${nanoid(12)}`;
          for (let index = 0; index < config.poolSize; index += 1) {
            const connection = new RelayConnection(config, index, sessionId, stats, reporter);
            connections.push(connection);
            connection.start();
          }

          return connections;
        }),
        (connections) =>
          Effect.sync(() => {
            for (const connection of connections) {
              connection.stop();
            }
          }),
      );

      return yield* Effect.never;
    }),
  );
}
