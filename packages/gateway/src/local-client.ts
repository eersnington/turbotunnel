/** Owns one local-client session, including registration, delivery acknowledgements, and pumps. */
import {
  decodeGatewayInboundFrameJson,
  decodeTunnelRequestFramePayload,
  LOCAL_CLIENT_ACK_TIMEOUT_MS,
  LOCAL_CLIENT_CAPACITY,
  localConsumerGroup,
  QUEUE_RECEIVE_COLD_AFTER_EMPTY,
  QUEUE_RECEIVE_COLD_DELAY_MS,
  QUEUE_RECEIVE_HOT_DELAY_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_RESPONSE_TTL_SECONDS,
  QUEUE_RECEIVE_WARM_DELAY_MS,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  requestTopic,
  type Frame,
  type GatewayInboundFrame,
  type HttpResponse,
  type WsClose,
  type WsData,
  type WsOpen,
  wsLocalInConsumerGroup,
} from "@turbotunnel/contracts";
import { Clock, Effect, FiberSet, Option, Scope } from "effect";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState, type LocalClient } from "./gateway-state.js";
import type { GatewayRequestHeaders } from "./headers.js";
import { extractSlugFromHost } from "./host.js";
import { routeWebSocketFrameToBrowser } from "./public-websocket.js";
import { publishPresence } from "./presence.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";
import type {
  GatewayWebSocket,
  GatewayWebSocketEvent,
  GatewayWebSocketWriteError,
} from "./websocket.js";

/** Expected dependency failures during a local-client connection. */
export type LocalClientError =
  | GatewayWebSocketWriteError
  | QueueAckError
  | QueueAuthError
  | QueueReceiveError
  | QueueSendError;

/** Runs the complete lifecycle of one authenticated local tunnel client. */
export const runLocalClient = Effect.fn("runLocalClient")(function* (
  socket: GatewayWebSocket,
  headers: GatewayRequestHeaders,
): Effect.fn.Return<void, LocalClientError, GatewayConfig | GatewayState | Queue | Scope.Scope> {
  const config = yield* GatewayConfig;
  const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
  if (slugResult._tag === "err") {
    yield* socket.close(1008, "invalid tunnel host");
    return;
  }

  const expectedSlug = slugResult.value;
  const firstEvent = yield* socket.receive;
  if (firstEvent._tag === "Close") {
    return;
  }
  const firstFrame = yield* decodeLocalClientMessage(socket, firstEvent);
  if (
    Option.isNone(firstFrame) ||
    firstFrame.value.type !== "local.hello" ||
    firstFrame.value.slug !== expectedSlug
  ) {
    if (Option.isSome(firstFrame)) {
      yield* socket.close(1008, "invalid local client hello");
    }
    return;
  }

  const state = yield* GatewayState;
  const frame = firstFrame.value;
  const connectedAt =
    frame.connectedAt === undefined ? yield* Clock.currentTimeMillis : frame.connectedAt;
  const localClient = yield* state.registerLocalClient({
    slug: frame.slug,
    socket,
    clientId: frame.localClientId,
    sessionId: frame.sessionId,
    generation: frame.generation,
    connectedAt,
    target: frame.target,
    capacity: Math.min(frame.capacity, LOCAL_CLIENT_CAPACITY),
  });
  const connectionFibers = yield* FiberSet.make<void, LocalClientError>();
  yield* Effect.logInfo("local tunnel client registered").pipe(
    Effect.annotateLogs({
      slug: localClient.slug,
      localClientId: localClient.clientId,
      sessionId: localClient.sessionId,
      generation: localClient.generation,
    }),
  );

  yield* Effect.addFinalizer(() =>
    publishPresence(localClient, "remove").pipe(
      Effect.catchTags({
        QueueAuthError: (error) => logPresenceRemovalFailure(localClient, error),
        QueueSendError: (error) => logPresenceRemovalFailure(localClient, error),
      }),
    ),
  );
  const connection = Effect.gen(function* () {
    yield* publishPresence(localClient, "upsert");
    const messages = processRegisteredLocalClient(socket, localClient);
    const pump = startLocalQueuePump(localClient, connectionFibers);
    yield* Effect.raceFirst(messages, pump).pipe(Effect.ensuring(FiberSet.clear(connectionFibers)));
  });
  yield* connection.pipe(
    terminateLocalConnectionOnPumpFailure(socket, localClient.slug, "local client handling"),
  );
});

/** Processes a registered session serially so acknowledgements cannot race registration. */
const processRegisteredLocalClient = Effect.fn("processRegisteredLocalClient")(function* (
  socket: GatewayWebSocket,
  localClient: LocalClient,
): Effect.fn.Return<void, LocalClientError, GatewayState | Queue> {
  const state = yield* GatewayState;
  while (true) {
    const event = yield* socket.receive;
    if (event._tag === "Close") {
      return;
    }
    const decoded = yield* decodeLocalClientMessage(socket, event);
    if (Option.isNone(decoded)) {
      return;
    }
    const frame = decoded.value;
    switch (frame.type) {
      case "local.hello":
        yield* socket.close(1008, "invalid local client hello");
        return;
      case "local.heartbeat":
        if (
          localClient.clientId !== frame.localClientId ||
          localClient.sessionId !== frame.sessionId ||
          localClient.generation !== frame.generation ||
          localClient.slug !== frame.slug
        ) {
          yield* socket.close(1008, "invalid local client heartbeat");
          return;
        }
        yield* publishPresence(localClient, "refresh");
        break;
      case "delivery.ack":
        yield* state.completeDeliveryAck(localClient, frame.ackFrameId, true);
        break;
      case "delivery.reject":
        yield* state.completeDeliveryAck(localClient, frame.rejectFrameId, false);
        break;
      case "http.response":
        yield* completeOrPublishHttpResponse(frame);
        break;
      case "ws.data":
      case "ws.close":
        yield* routeLocalWebSocketFrame(frame);
        break;
    }
  }
});

function logPresenceRemovalFailure(
  localClient: LocalClient,
  error: QueueAuthError | QueueSendError,
): Effect.Effect<void> {
  return Effect.logWarning("could not publish local tunnel disconnect presence").pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      slug: localClient.slug,
      localClientId: localClient.clientId,
      generation: localClient.generation,
    }),
  );
}

/** Applies the invalid-protocol policy at the local-client socket boundary. */
function decodeLocalClientMessage(
  socket: GatewayWebSocket,
  event: Extract<GatewayWebSocketEvent, { readonly _tag: "Message" }>,
): Effect.Effect<Option.Option<GatewayInboundFrame>> {
  const reject = (error: { readonly _tag: string }) =>
    Effect.logWarning("closing local client after invalid frame").pipe(
      Effect.annotateLogs({ errorTag: error._tag }),
      Effect.andThen(socket.close(1002, "invalid protocol frame")),
      Effect.as(Option.none<GatewayInboundFrame>()),
    );
  return decodeGatewayInboundFrameJson(event.data.toString("utf8")).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      ProtocolJsonDecodeError: reject,
      ProtocolPayloadDecodeError: reject,
    }),
  );
}

/** Delivers queued tunnel requests to a registered local client until it drains or disconnects. */
const startLocalQueuePump = Effect.fn("startLocalQueuePump")(function* (
  localClient: LocalClient,
  connectionFibers: FiberSet.FiberSet<void, LocalClientError>,
): Effect.fn.Return<void, LocalClientError, GatewayState | Queue> {
  const state = yield* GatewayState;
  const queue = yield* Queue;
  const topic = requestTopic(localClient.slug);
  const consumerGroup = localConsumerGroup(localClient.slug);
  while (yield* state.isLocalClientActive(localClient)) {
    const messages = yield* queue.receive({
      topic,
      consumerGroup,
      limit: QUEUE_RECEIVE_LIMIT,
      visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    });
    yield* state.recordMetric("queueReceives");
    if (messages.length === 0) {
      const emptyReceives = yield* state.noteQueueReceive(localClient, false);
      yield* Effect.sleep(queueReceiveDelay(emptyReceives));
      continue;
    }
    yield* state.noteQueueReceive(localClient, true);

    for (const message of messages) {
      const frameResult = yield* decodeTunnelRequestFramePayload(message.payload).pipe(
        Effect.map(Option.some),
        Effect.catchTags({ ProtocolPayloadDecodeError: () => Effect.succeed(Option.none()) }),
      );
      const now = yield* Clock.currentTimeMillis;
      if (Option.isNone(frameResult) || isExpired(frameResult.value, now)) {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        continue;
      }
      const frame = frameResult.value;

      const accepted = yield* state.sendFrameAndWaitForAck(
        localClient,
        frame,
        LOCAL_CLIENT_ACK_TIMEOUT_MS,
      );
      if (accepted) {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        if (frame.type === "ws.open") {
          yield* FiberSet.run(
            connectionFibers,
            startLocalWsInputPump(localClient, frame).pipe(
              terminateLocalConnectionOnPumpFailure(
                localClient.socket,
                localClient.slug,
                "local WebSocket input pump",
              ),
            ),
          );
        }
      }
    }
  }
});

/** Delivers one queued browser WebSocket input stream to its selected local client. */
const startLocalWsInputPump = Effect.fn("startLocalWsInputPump")(function* (
  localClient: LocalClient,
  openFrame: WsOpen,
): Effect.fn.Return<void, LocalClientError, GatewayState | Queue> {
  const state = yield* GatewayState;
  const queue = yield* Queue;
  const consumerGroup = wsLocalInConsumerGroup(openFrame.connId);
  while (yield* state.isLocalClientActive(localClient)) {
    const messages = yield* queue.receive({
      topic: openFrame.localInTopic,
      consumerGroup,
      limit: QUEUE_RECEIVE_LIMIT,
      visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    });
    yield* state.recordMetric("queueReceives");
    if (messages.length === 0) {
      const emptyReceives = yield* state.noteQueueReceive(localClient, false);
      yield* Effect.sleep(queueReceiveDelay(emptyReceives));
      continue;
    }
    yield* state.noteQueueReceive(localClient, true);

    for (const message of messages) {
      const frameResult = yield* decodeTunnelRequestFramePayload(message.payload).pipe(
        Effect.map(Option.some),
        Effect.catchTags({ ProtocolPayloadDecodeError: () => Effect.succeed(Option.none()) }),
      );
      const now = yield* Clock.currentTimeMillis;
      if (Option.isNone(frameResult) || isExpired(frameResult.value, now)) {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        continue;
      }
      const frame = frameResult.value;
      if (frame.type !== "ws.data" && frame.type !== "ws.close") {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
        continue;
      }

      const accepted = yield* state.sendFrameAndWaitForAck(
        localClient,
        frame,
        LOCAL_CLIENT_ACK_TIMEOUT_MS,
      );
      if (accepted) {
        yield* message.ack;
        yield* state.recordMetric("queueAcks");
      }
      if (accepted && frame.type === "ws.close") {
        return;
      }
    }
  }
});

/** Completes an in-process request or publishes its response for another gateway instance. */
function completeOrPublishHttpResponse(
  frame: HttpResponse,
): Effect.Effect<void, QueueAuthError | QueueSendError, GatewayState | Queue> {
  return Effect.gen(function* () {
    const state = yield* GatewayState;
    const queue = yield* Queue;
    if (yield* state.completeDirectRequest(frame)) {
      return;
    }
    yield* queue.send(frame.responseTopic, frame, {
      idempotencyKey: frame.frameId,
      ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
    });
    yield* state.recordMetric("queueSends");
  });
}

/** Routes a local WebSocket frame to an in-process browser or its remote output topic. */
function routeLocalWebSocketFrame(
  frame: WsData | WsClose,
): Effect.Effect<
  void,
  GatewayWebSocketWriteError | QueueAuthError | QueueSendError,
  GatewayState | Queue
> {
  return Effect.gen(function* () {
    const state = yield* GatewayState;
    const queue = yield* Queue;
    const publicConnection = yield* state.findPublicConnection(frame.connId);
    if (publicConnection !== undefined) {
      yield* routeWebSocketFrameToBrowser(publicConnection, frame);
      return;
    }
    if (frame.browserOutTopic !== undefined) {
      yield* queue.send(frame.browserOutTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      });
      yield* state.recordMetric("queueSends");
    }
  });
}

/** A failed delivery pump owns the local connection and forces its session scope to end. */
function terminateLocalConnectionOnPumpFailure(
  socket: GatewayWebSocket,
  slug: string,
  pump: string,
): <R>(effect: Effect.Effect<void, LocalClientError, R>) => Effect.Effect<void, never, R> {
  const terminate = (error: { readonly _tag: string }) =>
    Effect.logError(`${pump} failed`).pipe(
      Effect.annotateLogs({ errorTag: error._tag, slug }),
      Effect.andThen(socket.close(1011, "gateway queue operation failed")),
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

/** Selects the existing hot, warm, or cold queue polling delay. */
function queueReceiveDelay(emptyReceives: number): number {
  if (emptyReceives <= 1) {
    return QUEUE_RECEIVE_HOT_DELAY_MS;
  }
  if (emptyReceives < QUEUE_RECEIVE_COLD_AFTER_EMPTY) {
    return QUEUE_RECEIVE_WARM_DELAY_MS;
  }
  return QUEUE_RECEIVE_COLD_DELAY_MS;
}

/** Reports whether a queued frame's optional deadline has passed. */
function isExpired(frame: Frame, now: number): boolean {
  return "deadlineAt" in frame && frame.deadlineAt !== undefined && frame.deadlineAt < now;
}
