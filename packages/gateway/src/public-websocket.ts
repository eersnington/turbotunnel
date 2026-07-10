/** Owns one browser WebSocket lifecycle and its direct-or-queued frame routing. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

import {
  MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL,
  parseProtocolFramePayload,
  parseTunnelRequestTarget,
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
import { Clock, Effect, FiberSet, Result, Scope } from "effect";
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
export function runPublicWebSocket(
  socket: GatewayWebSocket,
  request: IncomingMessage,
  headers: GatewayRequestHeaders,
): Effect.Effect<void, PublicWebSocketError, GatewayConfig | GatewayState | Queue | Scope.Scope> {
  return Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const state = yield* GatewayState;
    const queue = yield* Queue;
    const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
    if (slugResult._tag === "err") {
      yield* socket.close(1008, "invalid tunnel host");
      return;
    }

    const slug = slugResult.value;
    const requestTarget = parseTunnelRequestTarget(request.url);
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
    if (Result.isFailure(requestTarget)) {
      yield* socket.close(1008, requestTarget.failure.message);
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
      path: requestTarget.success.path,
      headers: [...publicWebSocketHeaders(request.rawHeaders)],
    };
    const messageFibers = yield* FiberSet.make<void, PublicWebSocketError>();
    if (connection.route._tag === "Direct") {
      yield* state.recordMetric("directWebSocketOpens");
      const selectedLocalClient = yield* state.findLocalClient(connection.route.localClientId);
      if (selectedLocalClient !== undefined) {
        yield* selectedLocalClient.socket.sendFrame(openFrame);
      }
    } else {
      yield* state.recordMetric("queuedWebSocketOpens");
      yield* FiberSet.run(
        messageFibers,
        startPublicWsOutputPump(connection, state, queue).pipe(
          Effect.catch((error) =>
            Effect.logError("public WebSocket output pump failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag, slug }),
            ),
          ),
        ),
      );
      yield* queue.send(requestTopic(slug), openFrame, {
        idempotencyKey: openFrame.frameId,
        ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
      });
      yield* state.recordMetric("queueSends");
    }

    while (true) {
      const event = yield* socket.receive;
      if (event._tag === "Message") {
        const frame: WsData = {
          protocolVersion: PROTOCOL_VERSION,
          type: "ws.data",
          frameId: `frm_${nanoid(12)}`,
          connId,
          localInTopic: localInTopicName,
          seq: yield* state.nextBrowserSequence(connection),
          data: event.data.toString("base64"),
          binary: event.binary,
        };
        yield* FiberSet.run(
          messageFibers,
          sendBrowserWebSocketFrame(connection, frame, state, queue).pipe(
            Effect.catch((error) =>
              Effect.logError("browser WebSocket frame forwarding failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag, slug }),
              ),
            ),
          ),
        );
        continue;
      }

      yield* FiberSet.clear(messageFibers);
      const closeFrame: WsClose = {
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.close",
        frameId: `frm_${nanoid(12)}`,
        connId,
        localInTopic: localInTopicName,
        code: event.code,
        reason: event.reason,
      };
      yield* sendBrowserWebSocketFrame(connection, closeFrame, state, queue).pipe(
        Effect.catch((error) =>
          Effect.logError("browser WebSocket close forwarding failed").pipe(
            Effect.annotateLogs({ errorTag: error._tag, slug }),
          ),
        ),
      );
      return;
    }
  });
}

/** Sends directly when the selected client remains available, otherwise falls back to the queue. */
function sendBrowserWebSocketFrame(
  connection: PublicConnection,
  frame: WsData | WsClose,
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, GatewayWebSocketWriteError | QueueAuthError | QueueSendError> {
  return Effect.gen(function* () {
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
function startPublicWsOutputPump(
  connection: PublicConnection,
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, PublicWebSocketError> {
  return Effect.gen(function* () {
    const consumerGroup = wsBrowserOutConsumerGroup(connection.connId);
    while (yield* connection.socket.isOpen) {
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
        const frameResult = parseProtocolFramePayload(message.payload);
        if (Result.isFailure(frameResult)) {
          yield* message.ack;
          yield* state.recordMetric("queueAcks");
          continue;
        }
        const frame = frameResult.success;
        if (frame.type !== "ws.data" && frame.type !== "ws.close") {
          yield* message.ack;
          yield* state.recordMetric("queueAcks");
          continue;
        }
        yield* routeWebSocketFrameToBrowser(connection, frame, state);
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        if (frame.type === "ws.close") {
          return;
        }
      }
    }
  });
}

/** Applies sequence ordering and writes one local WebSocket frame to its browser socket. */
export function routeWebSocketFrameToBrowser(
  connection: PublicConnection,
  frame: WsData | WsClose,
  state: GatewayState["Service"],
): Effect.Effect<void, GatewayWebSocketWriteError> {
  return Effect.gen(function* () {
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
}
