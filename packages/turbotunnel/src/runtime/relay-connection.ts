import {
  decodeLocalClientInboundFrameJson,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_CLIENT_CAPACITY,
  LOCAL_CLIENT_SUBPROTOCOL,
  PROTOCOL_VERSION,
  type Frame,
  type LocalClientInboundFrame,
} from "@turbotunnel/contracts";
import { Clock, Console, Effect, Exit, FiberSet, Scope } from "effect";
import { nanoid } from "nanoid";

import { decodeUtf8 } from "../adapters/bytes.js";
import { acquireRelayWebSocket, type RelayWebSocket } from "../adapters/websocket.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import { relayHeaders, relaySocketUrl } from "../domain/tunnel-url.js";
import type { RelayWebSocketConnectError, RelayWebSocketWriteError } from "../errors.js";
import { forwardHttpToLocalApp } from "./forward-http.js";
import { openLocalWebSocket, type LocalWebSocketHandle } from "./forward-ws.js";
import { TunnelReporter } from "./tunnel-reporter.js";

export type TunnelSessionStats = {
  readonly startedAtMs: number;
  relayConnects: number;
  relayCloses: number;
  relayErrors: number;
  reconnects: number;
  framesReceived: number;
  framesSent: number;
  invalidFrames: number;
  httpRequests: number;
  httpResponses: number;
  webSocketsOpened: number;
  webSocketsClosed: number;
  activeRelayConnections: number;
  reachedConfiguredPool: boolean;
  readyPrinted: boolean;
};

type LocalConnection = {
  readonly handle: LocalWebSocketHandle;
};

/** Runs one relay pool slot, reconnecting until its parent Scope is closed. */
export const runRelayConnection = Effect.fn("runRelayConnection")(function* (
  config: HttpTunnelConfig,
  index: number,
  sessionId: string,
  stats: TunnelSessionStats,
): Effect.fn.Return<never, never, TunnelReporter> {
  const reporter = yield* TunnelReporter;
  const localClientId = `client_${nanoid(12)}`;
  let generation = 0;
  let reconnectDelayMs = 1_000;

  while (true) {
    generation += 1;
    let connected = false;
    let failureMessage: string | undefined;
    yield* runRelaySession(config, index, sessionId, localClientId, generation, stats, () => {
      connected = true;
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        RelayWebSocketConnectError: (error) =>
          Effect.sync(() => {
            failureMessage = error.message;
          }),
        RelayWebSocketWriteError: (error) =>
          Effect.sync(() => {
            failureMessage = error.message;
          }),
      }),
    );
    stats.relayCloses += 1;
    if (failureMessage !== undefined) {
      stats.relayErrors += 1;
      if (!stats.readyPrinted) {
        yield* reporter.warning(`! Relay socket ${index} failed to connect. ${failureMessage}`);
      }
    }

    stats.reconnects += 1;
    yield* Effect.sleep(connected ? 1_000 : reconnectDelayMs);
    reconnectDelayMs = connected ? 1_000 : Math.min(reconnectDelayMs * 2, 30_000);
  }
});

const runRelaySession = Effect.fn("runRelaySession")(function* (
  config: HttpTunnelConfig,
  index: number,
  sessionId: string,
  localClientId: string,
  generation: number,
  stats: TunnelSessionStats,
  onConnected: () => void,
): Effect.fn.Return<
  void,
  RelayWebSocketConnectError | RelayWebSocketWriteError,
  Scope.Scope | TunnelReporter
> {
  const reporter = yield* TunnelReporter;
  const parentScope = yield* Scope.Scope;
  const messageFibers = yield* FiberSet.make<void>();
  const localWebSockets = new Map<string, LocalConnection>();
  let connected = false;
  const socket = yield* acquireRelayWebSocket({
    url: relaySocketUrl(config),
    protocol: LOCAL_CLIENT_SUBPROTOCOL,
    headers: relayHeaders(config),
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (connected) stats.activeRelayConnections -= 1;
      stats.webSocketsClosed += localWebSockets.size;
      localWebSockets.clear();
      yield* socket
        .close(1001, "Turbotunnel process stopped")
        .pipe(
          Effect.catchTag("RelayWebSocketWriteError", (error) =>
            reporter.warning(`! Relay socket ${index} did not close cleanly. ${error.message}`),
          ),
        );
    }),
  );

  const first = yield* socket.receive;
  if (first._tag !== "Open") return;
  connected = true;
  stats.activeRelayConnections += 1;
  if (stats.activeRelayConnections === config.poolSize) stats.reachedConfiguredPool = true;
  onConnected();
  stats.relayConnects += 1;
  yield* sendFrame(socket, stats, {
    type: "local.hello",
    protocolVersion: PROTOCOL_VERSION,
    frameId: `frm_${nanoid(12)}`,
    slug: config.slug,
    localClientId,
    sessionId,
    generation,
    connectedAt: stats.startedAtMs,
    capacity: LOCAL_CLIENT_CAPACITY,
    target: config.target,
  });
  if (!stats.readyPrinted) {
    stats.readyPrinted = true;
    yield* reporter.ready();
  }

  const heartbeat = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(HEARTBEAT_INTERVAL_MS);
      const lastSeen = yield* Clock.currentTimeMillis;
      yield* sendFrame(socket, stats, {
        type: "local.heartbeat",
        protocolVersion: PROTOCOL_VERSION,
        frameId: `frm_${nanoid(12)}`,
        slug: config.slug,
        localClientId,
        sessionId,
        generation,
        lastSeen,
      });
    }
  });
  const receive = Effect.gen(function* () {
    while (true) {
      const event = yield* socket.receive;
      if (event._tag === "Close") return;
      if (event._tag === "Open") continue;
      stats.framesReceived += 1;
      if (event.binary) {
        stats.invalidFrames += 1;
        yield* Console.error(
          "! Discarded invalid relay frame: relay sent a binary WebSocket message.",
        );
        continue;
      }
      const decoded = yield* decodeRelayMessage(decodeUtf8(event.data), stats);
      if (decoded === undefined) continue;
      const handling = handleRelayFrame(
        socket,
        decoded,
        config,
        stats,
        localWebSockets,
        parentScope,
        messageFibers,
      ).pipe(
        Effect.catchTag("RelayWebSocketWriteError", (error) =>
          reporter
            .warning(`! Relay message ${index} failed. ${error.message}`)
            .pipe(Effect.andThen(socket.close(1011, "relay frame write failed"))),
        ),
      );
      if (decoded.type === "http.request") {
        yield* FiberSet.run(messageFibers, handling);
      } else {
        yield* handling;
      }
    }
  });

  yield* Effect.raceFirst(receive, heartbeat);
});

function decodeRelayMessage(
  text: string,
  stats: TunnelSessionStats,
): Effect.Effect<LocalClientInboundFrame | undefined> {
  return decodeLocalClientInboundFrameJson(text).pipe(
    Effect.catchTags({
      ProtocolJsonDecodeError: (error) => invalidFrame(stats, error.message),
      ProtocolPayloadDecodeError: (error) => invalidFrame(stats, error.message),
    }),
  );
}

const handleRelayFrame = Effect.fn("handleRelayFrame")(function* (
  socket: RelayWebSocket,
  decoded: LocalClientInboundFrame,
  config: HttpTunnelConfig,
  stats: TunnelSessionStats,
  localWebSockets: Map<string, LocalConnection>,
  parentScope: Scope.Scope,
  messageFibers: FiberSet.FiberSet<void>,
): Effect.fn.Return<void, RelayWebSocketWriteError> {
  switch (decoded.type) {
    case "http.request":
      stats.httpRequests += 1;
      yield* ack(socket, stats, decoded.frameId);
      yield* sendFrame(socket, stats, yield* forwardHttpToLocalApp(decoded, config.target));
      stats.httpResponses += 1;
      return;
    case "ws.open":
      stats.webSocketsOpened += 1;
      yield* ack(socket, stats, decoded.frameId);
      yield* openLocalConnection(
        socket,
        decoded,
        config,
        stats,
        localWebSockets,
        parentScope,
        messageFibers,
      );
      return;
    case "ws.data":
      {
        const connection = localWebSockets.get(decoded.connId);
        if (connection === undefined) {
          yield* reject(socket, stats, decoded.frameId, "local websocket connection was not found");
          return;
        }
        yield* connection.handle.sendData(decoded);
        yield* ack(socket, stats, decoded.frameId);
      }
      return;
    case "ws.close": {
      const connection = localWebSockets.get(decoded.connId);
      if (connection === undefined) {
        yield* reject(socket, stats, decoded.frameId, "local websocket connection was not found");
        return;
      }
      yield* connection.handle.close(decoded);
      yield* ack(socket, stats, decoded.frameId);
      return;
    }
    case "error":
      yield* Console.error(`! ${decoded.message}`);
      return;
  }
});

const openLocalConnection = Effect.fn("openLocalConnection")(function* (
  socket: RelayWebSocket,
  frame: Extract<LocalClientInboundFrame, { readonly type: "ws.open" }>,
  config: HttpTunnelConfig,
  stats: TunnelSessionStats,
  localWebSockets: Map<string, LocalConnection>,
  parentScope: Scope.Scope,
  messageFibers: FiberSet.FiberSet<void>,
): Effect.fn.Return<void, RelayWebSocketWriteError> {
  const childScope = yield* Scope.fork(parentScope);
  const handle = yield* openLocalWebSocket(frame, config.target, (relayFrame) =>
    sendFrame(socket, stats, relayFrame),
  ).pipe(
    Effect.provideService(Scope.Scope, childScope),
    Effect.catchTag("LocalWebSocketProtocolError", () =>
      Scope.close(childScope, Exit.void).pipe(Effect.as(undefined)),
    ),
  );
  if (handle === undefined) return;

  localWebSockets.set(frame.connId, { handle });
  yield* FiberSet.run(
    messageFibers,
    handle.closed.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (!localWebSockets.delete(frame.connId)) return Effect.void;
          stats.webSocketsClosed += 1;
          return Scope.close(childScope, Exit.void);
        }),
      ),
    ),
  );
});

function invalidFrame(stats: TunnelSessionStats, message: string): Effect.Effect<undefined> {
  stats.invalidFrames += 1;
  return Console.error(`! Discarded invalid relay frame: ${message}`).pipe(Effect.as(undefined));
}

function sendFrame(
  socket: RelayWebSocket,
  stats: TunnelSessionStats,
  frame: Frame,
): Effect.Effect<void, RelayWebSocketWriteError> {
  return socket.sendFrame(frame).pipe(Effect.tap(() => Effect.sync(() => (stats.framesSent += 1))));
}

function ack(socket: RelayWebSocket, stats: TunnelSessionStats, frameId: string) {
  return sendFrame(socket, stats, {
    protocolVersion: PROTOCOL_VERSION,
    type: "delivery.ack",
    frameId: `frm_${nanoid(12)}`,
    ackFrameId: frameId,
  });
}

function reject(
  socket: RelayWebSocket,
  stats: TunnelSessionStats,
  frameId: string,
  reason: string,
) {
  return sendFrame(socket, stats, {
    protocolVersion: PROTOCOL_VERSION,
    type: "delivery.reject",
    frameId: `frm_${nanoid(12)}`,
    rejectFrameId: frameId,
    reason,
  });
}
