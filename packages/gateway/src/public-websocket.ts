/** Owns one browser WebSocket lifecycle and its direct-or-queued frame routing. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

import {
  MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL,
  decodeBrowserOutputFramePayload,
  decodeTunnelRequestTarget,
  PROTOCOL_VERSION,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_RECEIVE_WARM_DELAY_MS,
  QUEUE_REQUEST_TTL_SECONDS,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  requestTopic,
  type WsClose,
  type WsData,
  type WsOpen,
  wsBrowserOutConsumerGroup,
  wsBrowserOutTopic,
  wsLocalInTopic,
} from "@turbotunnel/contracts";
import { Clock, Effect, Option, Scope } from "effect";
import { nanoid } from "nanoid";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState, type PublicConnection } from "./gateway-state.js";
import { type GatewayRequestHeaders, publicWebSocketHeaders } from "./headers.js";
import { extractSlugFromHost } from "./host.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";
import type { GatewayWebSocket, GatewayWebSocketWriteError } from "./websocket.js";

/** Expected dependency failures during a browser WebSocket connection. */
export type PublicWebSocketError =
  | GatewayWebSocketWriteError
  | QueueAckError
  | QueueAuthError
  | QueueReceiveError
  | QueueSendError;

/** Runs the complete lifecycle of one browser WebSocket connection. */
export const runPublicWebSocket = Effect.fn("runPublicWebSocket")(function* (
  socket: GatewayWebSocket,
  request: IncomingMessage,
  headers: GatewayRequestHeaders,
): Effect.fn.Return<
  void,
  PublicWebSocketError,
  GatewayConfig | GatewayState | Queue | Scope.Scope
> {
  const config = yield* GatewayConfig;
  const state = yield* GatewayState;
  const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
  if (slugResult._tag === "err") {
    yield* socket.close(1008, "invalid tunnel host");
    return;
  }

  const slug = slugResult.value;
  const connId = `ws_${nanoid(12)}`;
  const browserOutTopicName = wsBrowserOutTopic(connId);
  const localInTopicName = wsLocalInTopic(connId);
  const localClient = yield* state.pickLocalClient(slug);
  // Capacity rejection retains precedence when both admission and request-target checks fail.
  const registration = yield* state.registerPublicConnection({
    connId,
    slug,
    socket,
    browserOutTopic: browserOutTopicName,
    localInTopic: localInTopicName,
    localClient,
    capacity: MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL,
  });
  if (registration._tag === "AtCapacity") {
    yield* socket.close(1013, "too many websocket connections for tunnel");
    return;
  }
  const connection = registration.connection;
  const requestTarget = yield* decodeTunnelRequestTarget(request.url).pipe(
    Effect.map(Option.some),
    Effect.catchTag("TunnelRequestTargetError", (error) =>
      socket.close(1008, error.message).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(requestTarget)) {
    return;
  }

  const now = yield* Clock.currentTimeMillis;
  const openFrame: WsOpen = {
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.open",
    frameId: `frm_${nanoid(12)}`,
    connId,
    browserOutTopic: browserOutTopicName,
    localInTopic: localInTopicName,
    deadlineAt: now + PUBLIC_HTTP_TIMEOUT_MS,
    path: requestTarget.value.path,
    headers: [...publicWebSocketHeaders(request.rawHeaders)],
  };
  if (connection.route._tag === "Direct") {
    yield* state.recordMetric("directWebSocketOpens");
    const selectedLocalClient = yield* state.findLocalClient(connection.route.localClientId);
    if (selectedLocalClient !== undefined) {
      yield* selectedLocalClient.socket.sendFrame(openFrame);
    }
    yield* processBrowserMessages(socket, connection);
    return;
  }

  const queue = yield* Queue;
  yield* state.recordMetric("queuedWebSocketOpens");
  yield* queue.send(requestTopic(slug), openFrame, {
    idempotencyKey: openFrame.frameId,
    ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
  });
  yield* state.recordMetric("queueSends");
  yield* Effect.raceFirst(
    processBrowserMessages(socket, connection),
    startPublicWsOutputPump(connection).pipe(terminatePublicConnectionOnPumpFailure(connection)),
  );
});

/** Serializes browser input, sequence assignment, and forwarding for one connection. */
const processBrowserMessages = Effect.fn("processBrowserMessages")(function* (
  socket: GatewayWebSocket,
  connection: PublicConnection,
): Effect.fn.Return<void, PublicWebSocketError, GatewayState | Queue> {
  const state = yield* GatewayState;
  while (true) {
    const event = yield* socket.receive;
    if (event._tag === "Message") {
      const frame: WsData = {
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.data",
        frameId: `frm_${nanoid(12)}`,
        connId: connection.connId,
        localInTopic: connection.localInTopic,
        seq: yield* state.nextBrowserSequence(connection),
        data: event.data.toString("base64"),
        binary: event.binary,
      };
      yield* sendBrowserWebSocketFrame(connection, frame);
      continue;
    }

    const closeFrame: WsClose = {
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.close",
      frameId: `frm_${nanoid(12)}`,
      connId: connection.connId,
      localInTopic: connection.localInTopic,
      code: event.code,
      reason: event.reason,
    };
    yield* sendBrowserWebSocketFrame(connection, closeFrame);
    return;
  }
});

/** Sends directly when the selected client remains available, otherwise falls back to the queue. */
function sendBrowserWebSocketFrame(
  connection: PublicConnection,
  frame: WsData | WsClose,
): Effect.Effect<
  void,
  GatewayWebSocketWriteError | QueueAuthError | QueueSendError,
  GatewayState | Queue
> {
  return Effect.gen(function* () {
    const state = yield* GatewayState;
    const queue = yield* Queue;
    if (connection.route._tag === "Direct") {
      const localClient = yield* state.findLocalClient(connection.route.localClientId);
      if (localClient !== undefined && (yield* localClient.socket.sendFrame(frame))) {
        return;
      }
    }
    yield* queue.send(connection.localInTopic, frame, {
      idempotencyKey: frame.frameId,
      ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
    });
    yield* state.recordMetric("queueSends");
  });
}

/** Delivers queued local-client output frames to one browser connection in order. */
const startPublicWsOutputPump = Effect.fn("startPublicWsOutputPump")(function* (
  connection: PublicConnection,
): Effect.fn.Return<void, PublicWebSocketError, GatewayState | Queue> {
  const state = yield* GatewayState;
  const queue = yield* Queue;
  const consumerGroup = wsBrowserOutConsumerGroup(connection.connId);
  while (true) {
    const messages = yield* queue.receive({
      topic: connection.browserOutTopic,
      consumerGroup,
      limit: QUEUE_RECEIVE_LIMIT,
      visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    });
    yield* state.recordMetric("queueReceives");
    if (messages.length === 0) {
      yield* Effect.sleep(QUEUE_RECEIVE_WARM_DELAY_MS);
      continue;
    }

    for (const message of messages) {
      const frameResult = yield* decodeBrowserOutputFramePayload(message.payload).pipe(
        Effect.map(Option.some),
        Effect.catchTags({ ProtocolPayloadDecodeError: () => Effect.succeed(Option.none()) }),
      );
      if (Option.isNone(frameResult)) {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        continue;
      }
      const frame = frameResult.value;
      yield* routeWebSocketFrameToBrowser(connection, frame);
      yield* message.ack;
      yield* state.recordMetric("queueAcks");
      if (frame.type === "ws.close") {
        return;
      }
    }
  }
});

/** Applies sequence ordering and writes one local WebSocket frame to its browser socket. */
export const routeWebSocketFrameToBrowser = Effect.fn("routeWebSocketFrameToBrowser")(function* (
  connection: PublicConnection,
  frame: WsData | WsClose,
): Effect.fn.Return<void, GatewayWebSocketWriteError, GatewayState> {
  const state = yield* GatewayState;
  if (frame.type === "ws.data") {
    const transition = yield* state.acceptLocalSequence(connection, frame.seq);
    if (transition === "duplicate") {
      return;
    }
    if (transition === "gap") {
      yield* connection.socket.close(1011, "websocket queue sequence gap");
      return;
    }
    yield* connection.socket.sendData(Buffer.from(frame.data, "base64"), frame.binary);
    return;
  }

  yield* state.closePublicConnection(connection, frame.code, frame.reason);
});

/** A failed output pump owns and terminates its browser connection. */
function terminatePublicConnectionOnPumpFailure(
  connection: PublicConnection,
): <R>(effect: Effect.Effect<void, PublicWebSocketError, R>) => Effect.Effect<void, never, R> {
  const terminate = (error: { readonly _tag: string }) =>
    Effect.logError("public WebSocket output pump failed").pipe(
      Effect.annotateLogs({ errorTag: error._tag, slug: connection.slug }),
      Effect.andThen(connection.socket.close(1011, "gateway queue operation failed")),
    );
  return (effect) =>
    effect.pipe(
      Effect.catchTags({
        GatewayWebSocketWriteError: terminate,
        QueueAckError: terminate,
        QueueAuthError: terminate,
        QueueReceiveError: terminate,
        QueueSendError: terminate,
      }),
    );
}
