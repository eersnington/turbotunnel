import {
  decodeLocalClientInboundFrameJson,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_CLIENT_CAPACITY,
  LOCAL_CLIENT_SUBPROTOCOL,
  PROTOCOL_VERSION,
  type Frame,
  type LocalClientInboundFrame,
} from "@turbotunnel/contracts";
import { Clock, Effect, Exit, FiberSet, Scope } from "effect";
import { nanoid } from "nanoid";

import { decodeUtf8 } from "../adapters/bytes.js";
import { acquireRelayWebSocket, type RelayWebSocket } from "../adapters/websocket.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import { relayHeaders, relaySocketUrl } from "../domain/tunnel-url.js";
import type { RelayWebSocketConnectError, RelayWebSocketWriteError } from "../errors.js";
import { forwardHttpToLocalApp } from "./forward-http.js";
import { openLocalWebSocket, type LocalWebSocketHandle } from "./forward-ws.js";
import type { TunnelReporterShape } from "./tunnel-reporter.js";
import type { TunnelSession } from "./tunnel-session.js";

type LocalConnection = {
  readonly handle: LocalWebSocketHandle;
};

/** Runs one relay pool slot, reconnecting until its parent Scope is closed. */
export const runRelayConnection = Effect.fn("runRelayConnection")(function* (
  config: HttpTunnelConfig,
  index: number,
  sessionId: string,
  session: TunnelSession,
  reporter: TunnelReporterShape,
): Effect.fn.Return<never> {
  const localClientId = `client_${nanoid(12)}`;
  let generation = 0;
  let reconnectDelayMs = 1_000;

  while (true) {
    generation += 1;
    let connected = false;
    let failureMessage: string | undefined;
    yield* runRelaySession(
      config,
      index,
      sessionId,
      localClientId,
      generation,
      session,
      reporter,
      () => {
        connected = true;
      },
    ).pipe(
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
    const retryInMs = connected ? 1_000 : reconnectDelayMs;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* session.relayClosed({
      slot: index,
      nowMs,
      failure: failureMessage,
    });
    yield* session.relayReconnecting(index, retryInMs);
    yield* Effect.sleep(retryInMs);
    reconnectDelayMs = connected ? 1_000 : Math.min(retryInMs * 2, 30_000);
  }
});

const runRelaySession = Effect.fn("runRelaySession")(function* (
  config: HttpTunnelConfig,
  index: number,
  sessionId: string,
  localClientId: string,
  generation: number,
  session: TunnelSession,
  reporter: TunnelReporterShape,
  onConnected: () => void,
): Effect.fn.Return<void, RelayWebSocketConnectError | RelayWebSocketWriteError, Scope.Scope> {
  const parentScope = yield* Scope.Scope;
  const messageFibers = yield* FiberSet.make<void>();
  const localWebSockets = new Map<string, LocalConnection>();
  const socket = yield* acquireRelayWebSocket({
    url: relaySocketUrl(config),
    protocol: LOCAL_CLIENT_SUBPROTOCOL,
    headers: relayHeaders(config),
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* session.recordWebSocketsClosed(localWebSockets.size);
      localWebSockets.clear();
      yield* socket.close(1001, "Turbotunnel process stopped").pipe(
        Effect.catchTag("RelayWebSocketWriteError", (error) =>
          reporter.emit({
            _tag: "RecoverableWarning",
            warning: {
              failure: `Relay socket ${index + 1} did not close cleanly: ${error.message}`,
              attemptedRecovery: "Turbotunnel released the relay session cleanly where possible.",
              impact: "Other connected relays and the local application are unchanged.",
            },
          }),
        ),
      );
    }),
  );

  const first = yield* socket.receive;
  if (first._tag !== "Open") return;
  yield* sendFrame(socket, session, {
    type: "local.hello",
    protocolVersion: PROTOCOL_VERSION,
    frameId: `frm_${nanoid(12)}`,
    slug: config.slug,
    localClientId,
    sessionId,
    generation,
    connectedAt: session.snapshot().startedAtMs,
    capacity: LOCAL_CLIENT_CAPACITY,
    target: config.target,
  });
  onConnected();
  yield* session.relayConnected(index, yield* Clock.currentTimeMillis);

  const heartbeat = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(HEARTBEAT_INTERVAL_MS);
      const lastSeen = yield* Clock.currentTimeMillis;
      yield* sendFrame(socket, session, {
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
      yield* session.recordFrameReceived;
      if (event.binary) {
        yield* invalidFrame(session, reporter, "relay sent a binary WebSocket message");
        continue;
      }
      const decoded = yield* decodeRelayMessage(decodeUtf8(event.data), session, reporter);
      if (decoded === undefined) continue;
      const handling = handleRelayFrame(
        socket,
        decoded,
        config,
        session,
        reporter,
        localWebSockets,
        parentScope,
        messageFibers,
      ).pipe(
        Effect.catchTag("RelayWebSocketWriteError", (error) =>
          reporter
            .emit({
              _tag: "RecoverableWarning",
              warning: {
                failure: `Relay message ${index + 1} failed: ${error.message}`,
                attemptedRecovery: "Turbotunnel closed the relay socket and will reconnect.",
                impact: "In-flight traffic on this relay may need to retry.",
              },
            })
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
  session: TunnelSession,
  reporter: TunnelReporterShape,
): Effect.Effect<LocalClientInboundFrame | undefined> {
  return decodeLocalClientInboundFrameJson(text).pipe(
    Effect.catchTags({
      ProtocolJsonDecodeError: (error) => invalidFrame(session, reporter, error.message),
      ProtocolPayloadDecodeError: (error) => invalidFrame(session, reporter, error.message),
    }),
  );
}

const handleRelayFrame = Effect.fn("handleRelayFrame")(function* (
  socket: RelayWebSocket,
  decoded: LocalClientInboundFrame,
  config: HttpTunnelConfig,
  session: TunnelSession,
  reporter: TunnelReporterShape,
  localWebSockets: Map<string, LocalConnection>,
  parentScope: Scope.Scope,
  messageFibers: FiberSet.FiberSet<void>,
): Effect.fn.Return<void, RelayWebSocketWriteError> {
  switch (decoded.type) {
    case "http.request":
      yield* session.recordHttpRequest;
      yield* ack(socket, session, decoded.frameId);
      yield* sendFrame(socket, session, yield* forwardHttpToLocalApp(decoded, config.target));
      yield* session.recordHttpResponse;
      return;
    case "ws.open":
      yield* session.recordWebSocketOpened;
      yield* ack(socket, session, decoded.frameId);
      yield* openLocalConnection(
        socket,
        decoded,
        config,
        session,
        localWebSockets,
        parentScope,
        messageFibers,
      );
      return;
    case "ws.data":
      {
        const connection = localWebSockets.get(decoded.connId);
        if (connection === undefined) {
          yield* reject(
            socket,
            session,
            decoded.frameId,
            "local websocket connection was not found",
          );
          return;
        }
        yield* connection.handle.sendData(decoded);
        yield* ack(socket, session, decoded.frameId);
      }
      return;
    case "ws.close": {
      const connection = localWebSockets.get(decoded.connId);
      if (connection === undefined) {
        yield* reject(socket, session, decoded.frameId, "local websocket connection was not found");
        return;
      }
      yield* connection.handle.close(decoded);
      yield* ack(socket, session, decoded.frameId);
      return;
    }
    case "error":
      yield* reporter.emit({
        _tag: "RecoverableWarning",
        warning: {
          failure: `The relay reported an error: ${decoded.message}`,
          attemptedRecovery: "Turbotunnel kept the relay connection open.",
          impact: "Other tunnel traffic remains available.",
        },
      });
      return;
  }
});

const openLocalConnection = Effect.fn("openLocalConnection")(function* (
  socket: RelayWebSocket,
  frame: Extract<LocalClientInboundFrame, { readonly type: "ws.open" }>,
  config: HttpTunnelConfig,
  session: TunnelSession,
  localWebSockets: Map<string, LocalConnection>,
  parentScope: Scope.Scope,
  messageFibers: FiberSet.FiberSet<void>,
): Effect.fn.Return<void, RelayWebSocketWriteError> {
  const childScope = yield* Scope.fork(parentScope);
  const handle = yield* openLocalWebSocket(frame, config.target, (relayFrame) =>
    sendFrame(socket, session, relayFrame),
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
          return session
            .recordWebSocketsClosed(1)
            .pipe(Effect.andThen(Scope.close(childScope, Exit.void)));
        }),
      ),
    ),
  );
});

function invalidFrame(
  session: TunnelSession,
  reporter: TunnelReporterShape,
  message: string,
): Effect.Effect<undefined> {
  return Effect.gen(function* () {
    const shouldReport = yield* session.recordInvalidFrame;
    if (shouldReport) yield* reportInvalidFrame(reporter, message);
    return undefined;
  });
}

function reportInvalidFrame(reporter: TunnelReporterShape, message: string): Effect.Effect<void> {
  return reporter.emit({
    _tag: "RecoverableWarning",
    warning: {
      failure: `Discarded an invalid relay frame: ${message}`,
      attemptedRecovery: "Turbotunnel ignored the frame and kept the relay connected.",
      impact: "Other tunnel traffic remains available.",
    },
  });
}

function sendFrame(
  socket: RelayWebSocket,
  session: TunnelSession,
  frame: Frame,
): Effect.Effect<void, RelayWebSocketWriteError> {
  return socket.sendFrame(frame).pipe(Effect.tap(() => session.recordFrameSent));
}

function ack(socket: RelayWebSocket, session: TunnelSession, frameId: string) {
  return sendFrame(socket, session, {
    protocolVersion: PROTOCOL_VERSION,
    type: "delivery.ack",
    frameId: `frm_${nanoid(12)}`,
    ackFrameId: frameId,
  });
}

function reject(socket: RelayWebSocket, session: TunnelSession, frameId: string, reason: string) {
  return sendFrame(socket, session, {
    protocolVersion: PROTOCOL_VERSION,
    type: "delivery.reject",
    frameId: `frm_${nanoid(12)}`,
    rejectFrameId: frameId,
    reason,
  });
}
