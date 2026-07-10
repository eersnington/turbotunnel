/** Owns one local-client session, including registration, delivery acknowledgements, and pumps. */
import {
  isTunnelRequestFrame,
  LOCAL_CLIENT_ACK_TIMEOUT_MS,
  LOCAL_CLIENT_CAPACITY,
  localConsumerGroup,
  parseProtocolFrameJson,
  parseProtocolFramePayload,
  QUEUE_RECEIVE_COLD_AFTER_EMPTY,
  QUEUE_RECEIVE_COLD_DELAY_MS,
  QUEUE_RECEIVE_HOT_DELAY_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_RESPONSE_TTL_SECONDS,
  QUEUE_RECEIVE_WARM_DELAY_MS,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  requestTopic,
  type Frame,
  type HttpResponse,
  type WsClose,
  type WsData,
  type WsOpen,
  wsLocalInConsumerGroup,
} from "@turbotunnel/contracts";
import { Clock, Effect, FiberSet, Result, Scope } from "effect";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState, type LocalClient } from "./gateway-state.js";
import type { GatewayRequestHeaders } from "./headers.js";
import { extractSlugFromHost } from "./host.js";
import { routeWebSocketFrameToBrowser } from "./public-websocket.js";
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
export function runLocalClient(
  socket: GatewayWebSocket,
  headers: GatewayRequestHeaders,
): Effect.Effect<void, LocalClientError, GatewayConfig | GatewayState | Queue | Scope.Scope> {
  return Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const state = yield* GatewayState;
    const queue = yield* Queue;
    const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
    if (slugResult._tag === "err") {
      yield* socket.close(1008, "invalid tunnel host");
      return;
    }

    const expectedSlug = slugResult.value;
    const connectionFibers = yield* FiberSet.make<void, LocalClientError>();
    let registered: LocalClient | undefined;

    while (true) {
      const event = yield* socket.receive;
      if (event._tag === "Close") {
        return;
      }
      yield* FiberSet.run(
        connectionFibers,
        handleLocalClientMessage(event).pipe(
          Effect.catch((error) =>
            Effect.logError("local client message handling failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag }),
            ),
          ),
        ),
      );
    }

    /** Parses and routes one local-client protocol message within the connection scope. */
    function handleLocalClientMessage(
      event: Extract<GatewayWebSocketEvent, { readonly _tag: "Message" }>,
    ): Effect.Effect<void, LocalClientError, Scope.Scope> {
      return Effect.gen(function* () {
        const frameResult = parseProtocolFrameJson(event.data.toString("utf8"));
        if (Result.isFailure(frameResult)) {
          yield* Effect.logWarning("closing local client after invalid frame").pipe(
            Effect.annotateLogs({ reason: frameResult.failure.reason }),
          );
          yield* socket.close(1002, "invalid protocol frame");
          return;
        }

        const frame = frameResult.success;
        switch (frame.type) {
          case "local.hello": {
            if (registered !== undefined || frame.slug !== expectedSlug) {
              yield* socket.close(1008, "invalid local client hello");
              return;
            }

            const localClient = yield* state.registerLocalClient({
              slug: frame.slug,
              socket,
              clientId: frame.localClientId,
              sessionId: frame.sessionId,
              generation: frame.generation,
              target: frame.target,
              capacity: Math.min(frame.capacity, LOCAL_CLIENT_CAPACITY),
            });
            registered = localClient;
            yield* FiberSet.run(
              connectionFibers,
              startLocalQueuePump(localClient, connectionFibers, state, queue).pipe(
                Effect.catch((error) =>
                  Effect.logError("local queue pump failed").pipe(
                    Effect.annotateLogs({ errorTag: error._tag, slug: localClient.slug }),
                  ),
                ),
              ),
            );
            yield* Effect.logInfo("local tunnel client registered").pipe(
              Effect.annotateLogs({
                slug: localClient.slug,
                localClientId: localClient.clientId,
                sessionId: localClient.sessionId,
                generation: localClient.generation,
              }),
            );
            return;
          }
          case "local.heartbeat": {
            if (
              registered === undefined ||
              registered.clientId !== frame.localClientId ||
              registered.sessionId !== frame.sessionId ||
              registered.generation !== frame.generation ||
              registered.slug !== frame.slug
            ) {
              yield* socket.close(1008, "invalid local client heartbeat");
            }
            return;
          }
          case "delivery.ack":
            yield* state.completeDeliveryAck(registered, frame.ackFrameId, true);
            return;
          case "delivery.reject":
            yield* state.completeDeliveryAck(registered, frame.rejectFrameId, false);
            return;
          case "http.response":
            yield* completeOrPublishHttpResponse(frame, state, queue);
            return;
          case "ws.data":
          case "ws.close":
            yield* routeLocalWebSocketFrame(frame, state, queue);
            return;
          case "error":
          case "http.request":
          case "ws.open":
            yield* socket.close(1008, "frame type is not accepted from local client");
            return;
        }
      });
    }
  });
}

/** Delivers queued tunnel requests to a registered local client until it drains or disconnects. */
function startLocalQueuePump(
  localClient: LocalClient,
  connectionFibers: FiberSet.FiberSet<void, LocalClientError>,
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, LocalClientError> {
  return Effect.gen(function* () {
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
        const frameResult = parseProtocolFramePayload(message.payload);
        const now = yield* Clock.currentTimeMillis;
        if (Result.isFailure(frameResult) || isExpired(frameResult.success, now)) {
          yield* message.ack;
          yield* state.recordMetric("queueAcks");
          continue;
        }
        const frame = frameResult.success;
        if (!isTunnelRequestFrame(frame)) {
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
          if (frame.type === "ws.open") {
            yield* FiberSet.run(
              connectionFibers,
              startLocalWsInputPump(localClient, frame, state, queue).pipe(
                Effect.catch((error) =>
                  Effect.logError("local WebSocket input pump failed").pipe(
                    Effect.annotateLogs({ errorTag: error._tag, slug: localClient.slug }),
                  ),
                ),
              ),
            );
          }
        }
      }
    }
  });
}

/** Delivers one queued browser WebSocket input stream to its selected local client. */
function startLocalWsInputPump(
  localClient: LocalClient,
  openFrame: WsOpen,
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, LocalClientError> {
  return Effect.gen(function* () {
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
        const frameResult = parseProtocolFramePayload(message.payload);
        const now = yield* Clock.currentTimeMillis;
        if (Result.isFailure(frameResult) || isExpired(frameResult.success, now)) {
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

        const accepted = yield* state.sendFrameAndWaitForAck(
          localClient,
          frame,
          LOCAL_CLIENT_ACK_TIMEOUT_MS,
        );
        if (accepted) {
          yield* message.ack;
          yield* state.recordMetric("queueAcks");
        }
        if (frame.type === "ws.close") {
          return;
        }
      }
    }
  });
}

/** Completes an in-process request or publishes its response for another gateway instance. */
function completeOrPublishHttpResponse(
  frame: HttpResponse,
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, QueueAuthError | QueueSendError> {
  return Effect.gen(function* () {
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
  state: GatewayState["Service"],
  queue: Queue["Service"],
): Effect.Effect<void, GatewayWebSocketWriteError | QueueAuthError | QueueSendError> {
  return Effect.gen(function* () {
    const publicConnection = yield* state.findPublicConnection(frame.connId);
    if (publicConnection !== undefined) {
      yield* routeWebSocketFrameToBrowser(publicConnection, frame, state);
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
