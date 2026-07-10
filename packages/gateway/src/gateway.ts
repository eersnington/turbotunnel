import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  httpResponseTopic,
  isTunnelRequestFrame,
  LOCAL_CLIENT_ACK_TIMEOUT_MS,
  LOCAL_CLIENT_CAPACITY,
  LOCAL_CLIENT_SUBPROTOCOL,
  localConsumerGroup,
  MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL,
  MAX_REQUEST_BODY_BYTES,
  parseProtocolFrameJson,
  parseProtocolFramePayload,
  parseTunnelRequestTarget,
  PROTOCOL_VERSION,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_COLD_AFTER_EMPTY,
  QUEUE_RECEIVE_COLD_DELAY_MS,
  QUEUE_RECEIVE_HOT_DELAY_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_REQUEST_TTL_SECONDS,
  QUEUE_RESPONSE_TTL_SECONDS,
  QUEUE_RECEIVE_WARM_DELAY_MS,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  requestTopic,
  type Frame,
  type HttpRequest,
  type HttpResponse,
  TURBOTUNNEL_VERSION,
  type TunnelRequestFrame,
  type WsClose,
  type WsData,
  type WsOpen,
  wsBrowserOutConsumerGroup,
  wsBrowserOutTopic,
  wsLocalInConsumerGroup,
  wsLocalInTopic,
} from "@turbotunnel/contracts";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Option,
  Redacted,
  Result,
  Scope,
} from "effect";
import { nanoid } from "nanoid";
import { WebSocketServer } from "ws";

import { GatewayConfig } from "./gateway-config.js";
import {
  type GatewayRequestHeaders,
  parseGatewayRequestHeaders,
  publicWebSocketHeaders,
  requestHeadersForLocalApp,
  responseHeadersForBrowser,
} from "./headers.js";
import { extractSlugFromHost, isGatewayRootHost } from "./host.js";
import { MemoryQueue } from "./memory-queue.js";
import { OidcToken } from "./oidc-token.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";
import { waitForHttpResponseFromQueue } from "./response-waiter.js";
import { VercelQueue } from "./vercel-queue.js";
import {
  acquireGatewayWebSocket,
  type GatewayWebSocket,
  type GatewayWebSocketEvent,
  type GatewayWebSocketWriteError,
} from "./websocket.js";

type LocalTarget = {
  readonly protocol: "http";
  readonly host: string;
  readonly port: number;
};

type LocalClientSocket = {
  readonly slug: string;
  readonly socket: GatewayWebSocket;
  readonly clientId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly target: LocalTarget;
  readonly pendingDeliveryAcks: Map<string, Deferred.Deferred<boolean>>;
  readonly pendingDirectHttpRequests: Set<string>;
  inFlight: number;
  capacity: number;
  draining: boolean;
  emptyQueueReceives: number;
};

type DirectHttpResult =
  | { readonly _tag: "response"; readonly response: HttpResponse }
  | { readonly _tag: "disconnected" };

type PendingHttpRequest = {
  readonly result: Deferred.Deferred<DirectHttpResult>;
};

type GatewayStats = {
  readonly startedAt: number;
  directHttpRequests: number;
  queuedHttpRequests: number;
  directWebSocketOpens: number;
  queuedWebSocketOpens: number;
  queueReceives: number;
  queueSends: number;
  queueAcks: number;
};

type PublicWsConnectionBase = {
  readonly connId: string;
  readonly slug: string;
  readonly socket: GatewayWebSocket;
  readonly browserOutTopic: string;
  readonly localInTopic: string;
  nextBrowserSeq: number;
  nextLocalSeq: number;
};

type PublicWsConnection =
  | (PublicWsConnectionBase & {
      readonly _tag: "Direct";
      readonly localClientId: string;
    })
  | (PublicWsConnectionBase & { readonly _tag: "Queued" });

type GatewayOperationError =
  | GatewayWebSocketWriteError
  | QueueAckError
  | QueueAuthError
  | QueueReceiveError
  | QueueSendError;

/** Constructs a scoped Node gateway server with Effect-owned request and connection fibers. */
const makeGatewayServer = Effect.fn("makeGatewayServer")(function* (): Effect.fn.Return<
  Server,
  never,
  GatewayConfig | Queue | OidcToken | Scope.Scope
> {
  const config = yield* GatewayConfig;
  const queue = yield* Queue;
  const oidcToken = yield* OidcToken;
  const runServerFiber = yield* FiberSet.makeRuntime<never, void, never>();
  const localClients = new Map<string, LocalClientSocket>();
  const localClientIdsBySlug = new Map<string, Set<string>>();
  const pendingHttpRequests = new Map<string, PendingHttpRequest>();
  const publicWebSockets = new Map<string, PublicWsConnection>();
  const publicWebSocketCountsBySlug = new Map<string, number>();
  const stats: GatewayStats = {
    startedAt: yield* Clock.currentTimeMillis,
    directHttpRequests: 0,
    queuedHttpRequests: 0,
    directWebSocketOpens: 0,
    queuedWebSocketOpens: 0,
    queueReceives: 0,
    queueSends: 0,
    queueAcks: 0,
  };

  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(LOCAL_CLIENT_SUBPROTOCOL) ? LOCAL_CLIENT_SUBPROTOCOL : false;
    },
  });

  const server = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const nodeServer = createServer((request, response) => {
        const fiber = runServerFiber(
          handlePublicHttp(request, response).pipe(
            Effect.catch((error) =>
              Effect.logError("gateway HTTP request failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag }),
                Effect.andThen(
                  Effect.sync(() =>
                    writePlainResponse(
                      response,
                      503,
                      "Gateway queue operation failed. The local tunnel app was not contacted or did not receive the response.",
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        const interruptOnClose = (): void => {
          if (!response.writableEnded) {
            // SAFETY: this callback is the Node boundary; the fiber remains owned by the server FiberSet.
            fiber.interruptUnsafe();
          }
        };
        response.once("close", interruptOnClose);
        fiber.addObserver(() => response.removeListener("close", interruptOnClose));
      });

      nodeServer.on("upgrade", (request, socket, head) => {
        runServerFiber(
          handleUpgrade(request, socket, head).pipe(
            Effect.catch((error) =>
              Effect.logError("gateway WebSocket connection failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag }),
              ),
            ),
          ),
        );
      });
      return nodeServer;
    }),
    closeNodeServer,
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
    }),
  );
  yield* Effect.logInfo("gateway started").pipe(
    Effect.annotateLogs({ brokerKind: config.brokerKind, queueRegion: config.queueRegion }),
  );
  return server;

  function handlePublicHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const headersResult = parseGatewayRequestHeaders(request.rawHeaders);
      if (headersResult._tag === "err") {
        writePlainResponse(
          response,
          400,
          `Request contained more than one ${headersResult.header} header. The gateway did not contact the local app.`,
        );
        return;
      }

      const headers = headersResult.value;
      if (headers.oidcToken !== undefined) {
        yield* oidcToken.set(headers.oidcToken);
      }
      if (request.url === "/_turbotunnel/status") {
        yield* writeGatewayStatus(response, config, localClients, stats, request);
        return;
      }

      const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
      if (slugResult._tag === "err") {
        if (isGatewayRootHost(headers.host, config.baseDomain)) {
          yield* writeGatewayStatus(response, config, localClients, stats, request);
          return;
        }
        writePlainResponse(response, 404, "Tunnel host was not recognized for this relay domain.");
        return;
      }

      const bodyResult = yield* readLimitedBody(request, MAX_REQUEST_BODY_BYTES);
      if (bodyResult._tag === "err") {
        writePlainResponse(
          response,
          bodyResult.error.reason === "too-large" ? 413 : 400,
          bodyResult.error.reason === "too-large"
            ? "Request body is larger than the tunnel limit. The local app was not contacted."
            : "Request body could not be read. The local app was not contacted.",
        );
        return;
      }

      const requestTarget = parseTunnelRequestTarget(request.url);
      if (Result.isFailure(requestTarget)) {
        writePlainResponse(response, 400, requestTarget.failure.message);
        return;
      }

      const slug = slugResult.value;
      const requestId = `req_${nanoid(12)}`;
      const responseTopicName = httpResponseTopic(requestId);
      const localClient = yield* pickLocalClientOnThisInstance(slug);
      const localHost =
        localClient === undefined
          ? (headers.host ?? "")
          : `${localClient.target.host}:${localClient.target.port}`;
      const now = yield* Clock.currentTimeMillis;
      const frame: HttpRequest = {
        protocolVersion: PROTOCOL_VERSION,
        type: "http.request",
        frameId: `frm_${nanoid(12)}`,
        requestId,
        responseTopic: responseTopicName,
        deadlineAt: now + PUBLIC_HTTP_TIMEOUT_MS,
        method: request.method ?? "GET",
        path: requestTarget.success.path,
        headers: [
          ...requestHeadersForLocalApp({
            rawHeaders: request.rawHeaders,
            localHost,
            forwardedHost: headers.host ?? "",
            forwardedProto: headers.forwardedProto,
            requestId,
          }),
        ],
        body: bodyResult.value.toString("base64"),
      };

      if (localClient !== undefined) {
        stats.directHttpRequests += 1;
        const direct = yield* forwardHttpDirect(localClient, frame);
        switch (direct._tag) {
          case "response":
            writeHttpResponse(response, direct.response);
            return;
          case "disconnected-before-forwarding":
            writePlainResponse(
              response,
              502,
              "Local tunnel client disconnected before forwarding.",
            );
            return;
          case "disconnected-before-response":
            writePlainResponse(
              response,
              502,
              "Local tunnel client disconnected before the local app responded.",
            );
            return;
          case "timeout":
            writePlainResponse(
              response,
              504,
              "Tunnel request timed out before the local app responded. The local app may still have received the request.",
            );
            return;
        }
      }

      stats.queuedHttpRequests += 1;
      yield* queue.send(requestTopic(slug), frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
      });
      stats.queueSends += 1;

      const result = yield* waitForHttpResponseFromQueue({
        queue,
        requestId,
        responseTopic: responseTopicName,
        timeoutMs: PUBLIC_HTTP_TIMEOUT_MS,
      });
      if (result._tag === "ok") {
        writeHttpResponse(response, result.value);
        return;
      }
      if (result._tag === "timeout") {
        writePlainResponse(
          response,
          504,
          "Tunnel request timed out before a local tunnel client responded.",
        );
      }
    });
  }

  function forwardHttpDirect(localClient: LocalClientSocket, frame: HttpRequest) {
    return Effect.gen(function* () {
      const result = yield* Deferred.make<DirectHttpResult>();
      pendingHttpRequests.set(frame.requestId, { result });
      localClient.pendingDirectHttpRequests.add(frame.requestId);
      localClient.inFlight += 1;

      return yield* Effect.gen(function* () {
        if (!(yield* localClient.socket.sendFrame(frame))) {
          return { _tag: "disconnected-before-forwarding" } as const;
        }

        const completed = yield* Deferred.await(result).pipe(
          Effect.timeoutOption(PUBLIC_HTTP_TIMEOUT_MS),
        );
        if (Option.isNone(completed)) {
          return { _tag: "timeout" } as const;
        }
        return completed.value._tag === "response"
          ? ({ _tag: "response", response: completed.value.response } as const)
          : ({ _tag: "disconnected-before-response" } as const);
      }).pipe(
        Effect.ensuring(Effect.sync(() => releaseDirectHttpRequest(localClient, frame.requestId))),
      );
    });
  }

  function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const headersResult = parseGatewayRequestHeaders(request.rawHeaders);
      if (headersResult._tag === "err") {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }

      const headers = headersResult.value;
      if (headers.oidcToken !== undefined) {
        yield* oidcToken.set(headers.oidcToken);
      }
      const isLocalClientAttempt = headers.secWebSocketProtocols.includes(LOCAL_CLIENT_SUBPROTOCOL);
      if (
        isLocalClientAttempt &&
        !hasValidBearerAuth(headers.authorization, Redacted.value(config.relaySecret))
      ) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      const rawWebSocket = yield* acceptUpgrade(webSocketServer, request, socket, head);
      if (isLocalClientAttempt) {
        yield* runLocalClientSocket(rawWebSocket, headers).pipe(Effect.scoped);
        return;
      }

      yield* runPublicWebSocket(rawWebSocket, request, headers).pipe(
        Effect.catch((error) =>
          Effect.logError("public WebSocket handling failed").pipe(
            Effect.annotateLogs({ errorTag: error._tag }),
            Effect.andThen(
              Effect.sync(() => rawWebSocket.close(1011, "gateway queue operation failed")),
            ),
          ),
        ),
        Effect.scoped,
      );
    });
  }

  function runLocalClientSocket(
    rawWebSocket: import("ws").WebSocket,
    headers: GatewayRequestHeaders,
  ): Effect.Effect<void, GatewayOperationError, Scope.Scope> {
    return Effect.gen(function* () {
      const socket = yield* acquireGatewayWebSocket(rawWebSocket);
      const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
      if (slugResult._tag === "err") {
        yield* socket.close(1008, "invalid tunnel host");
        return;
      }

      const expectedSlug = slugResult.value;
      const connectionFibers = yield* FiberSet.make<void, GatewayOperationError>();
      let registered: LocalClientSocket | undefined;
      yield* Effect.addFinalizer(() => cleanupLocalClient(registered));

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

      function handleLocalClientMessage(
        event: Extract<GatewayWebSocketEvent, { readonly _tag: "Message" }>,
      ): Effect.Effect<void, GatewayOperationError> {
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

              const localClient: LocalClientSocket = {
                slug: frame.slug,
                socket,
                clientId: frame.localClientId,
                sessionId: frame.sessionId,
                generation: frame.generation,
                target: frame.target,
                pendingDeliveryAcks: new Map(),
                pendingDirectHttpRequests: new Set(),
                inFlight: 0,
                capacity: Math.min(frame.capacity, LOCAL_CLIENT_CAPACITY),
                draining: false,
                emptyQueueReceives: 0,
              };
              drainOlderLocalClients(localClient);
              registered = localClient;
              localClients.set(localClient.clientId, localClient);
              const clientIds = localClientIdsBySlug.get(localClient.slug) ?? new Set<string>();
              clientIds.add(localClient.clientId);
              localClientIdsBySlug.set(localClient.slug, clientIds);
              yield* FiberSet.run(
                connectionFibers,
                startLocalQueuePump(localClient, connectionFibers).pipe(
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
              yield* completeDeliveryAck(registered, frame.ackFrameId, true);
              return;
            case "delivery.reject":
              yield* completeDeliveryAck(registered, frame.rejectFrameId, false);
              return;
            case "http.response":
              yield* completeOrPublishHttpResponse(frame);
              return;
            case "ws.data":
              yield* routeLocalWebSocketFrame(frame);
              return;
            case "ws.close":
              yield* routeLocalWebSocketFrame(frame);
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

  function cleanupLocalClient(registered: LocalClientSocket | undefined): Effect.Effect<void> {
    return Effect.gen(function* () {
      if (registered === undefined) {
        return;
      }
      registered.draining = true;
      localClients.delete(registered.clientId);
      localClientIdsBySlug.get(registered.slug)?.delete(registered.clientId);
      for (const pending of registered.pendingDeliveryAcks.values()) {
        yield* Deferred.succeed(pending, false);
      }
      registered.pendingDeliveryAcks.clear();
      for (const requestId of registered.pendingDirectHttpRequests) {
        const pending = pendingHttpRequests.get(requestId);
        if (pending !== undefined) {
          yield* Deferred.succeed(pending.result, { _tag: "disconnected" });
          pendingHttpRequests.delete(requestId);
        }
      }
      registered.pendingDirectHttpRequests.clear();
      registered.inFlight = 0;
    });
  }

  function completeDeliveryAck(
    registered: LocalClientSocket | undefined,
    frameId: string,
    accepted: boolean,
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      const pending = registered?.pendingDeliveryAcks.get(frameId);
      if (pending === undefined) {
        return;
      }
      registered?.pendingDeliveryAcks.delete(frameId);
      yield* Deferred.succeed(pending, accepted);
    });
  }

  function startLocalQueuePump(
    localClient: LocalClientSocket,
    connectionFibers: FiberSet.FiberSet<void, GatewayOperationError>,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const topic = requestTopic(localClient.slug);
      const consumerGroup = localConsumerGroup(localClient.slug);
      while ((yield* localClient.socket.isOpen) && !localClient.draining) {
        const messages = yield* queue.receive({
          topic,
          consumerGroup,
          limit: QUEUE_RECEIVE_LIMIT,
          visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
        });
        stats.queueReceives += 1;
        if (messages.length === 0) {
          localClient.emptyQueueReceives += 1;
          yield* Effect.sleep(queueReceiveDelay(localClient.emptyQueueReceives));
          continue;
        }
        localClient.emptyQueueReceives = 0;

        for (const message of messages) {
          const frameResult = parseProtocolFramePayload(message.payload);
          const now = yield* Clock.currentTimeMillis;
          if (Result.isFailure(frameResult) || isExpired(frameResult.success, now)) {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }
          const frame = frameResult.success;
          if (!isTunnelRequestFrame(frame)) {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }

          const accepted = yield* sendFrameToLocalClientAndWaitForAck(localClient, frame);
          if (accepted) {
            yield* message.ack;
            stats.queueAcks += 1;
            if (frame.type === "ws.open") {
              yield* FiberSet.run(
                connectionFibers,
                startLocalWsInputPump(localClient, frame).pipe(
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

  function startLocalWsInputPump(
    localClient: LocalClientSocket,
    openFrame: WsOpen,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const consumerGroup = wsLocalInConsumerGroup(openFrame.connId);
      while ((yield* localClient.socket.isOpen) && !localClient.draining) {
        const messages = yield* queue.receive({
          topic: openFrame.localInTopic,
          consumerGroup,
          limit: QUEUE_RECEIVE_LIMIT,
          visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
        });
        stats.queueReceives += 1;
        if (messages.length === 0) {
          localClient.emptyQueueReceives += 1;
          yield* Effect.sleep(queueReceiveDelay(localClient.emptyQueueReceives));
          continue;
        }
        localClient.emptyQueueReceives = 0;

        for (const message of messages) {
          const frameResult = parseProtocolFramePayload(message.payload);
          const now = yield* Clock.currentTimeMillis;
          if (Result.isFailure(frameResult) || isExpired(frameResult.success, now)) {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }
          const frame = frameResult.success;
          if (frame.type !== "ws.data" && frame.type !== "ws.close") {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }

          const accepted = yield* sendFrameToLocalClientAndWaitForAck(localClient, frame);
          if (accepted) {
            yield* message.ack;
            stats.queueAcks += 1;
          }
          if (frame.type === "ws.close") {
            return;
          }
        }
      }
    });
  }

  function sendFrameToLocalClientAndWaitForAck(
    localClient: LocalClientSocket,
    frame: TunnelRequestFrame,
  ): Effect.Effect<boolean, GatewayWebSocketWriteError> {
    return Effect.gen(function* () {
      const acknowledgement = yield* Deferred.make<boolean>();
      localClient.pendingDeliveryAcks.set(frame.frameId, acknowledgement);
      return yield* Effect.gen(function* () {
        if (!(yield* localClient.socket.sendFrame(frame))) {
          return false;
        }
        return yield* Deferred.await(acknowledgement).pipe(
          Effect.timeoutOrElse({
            duration: LOCAL_CLIENT_ACK_TIMEOUT_MS,
            orElse: () => Effect.succeed(false),
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            localClient.pendingDeliveryAcks.delete(frame.frameId);
          }),
        ),
      );
    });
  }

  function runPublicWebSocket(
    rawWebSocket: import("ws").WebSocket,
    request: IncomingMessage,
    headers: GatewayRequestHeaders,
  ): Effect.Effect<void, GatewayOperationError, Scope.Scope> {
    return Effect.gen(function* () {
      const socket = yield* acquireGatewayWebSocket(rawWebSocket);
      const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
      if (slugResult._tag === "err") {
        yield* socket.close(1008, "invalid tunnel host");
        return;
      }

      const slug = slugResult.value;
      const existingCount = publicWebSocketCountsBySlug.get(slug) ?? 0;
      if (existingCount >= MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL) {
        yield* socket.close(1013, "too many websocket connections for tunnel");
        return;
      }
      const requestTarget = parseTunnelRequestTarget(request.url);
      if (Result.isFailure(requestTarget)) {
        yield* socket.close(1008, requestTarget.failure.message);
        return;
      }

      const connId = `ws_${nanoid(12)}`;
      const browserOutTopicName = wsBrowserOutTopic(connId);
      const localInTopicName = wsLocalInTopic(connId);
      const localClient = yield* pickLocalClientOnThisInstance(slug);
      const baseConnection: PublicWsConnectionBase = {
        connId,
        slug,
        socket,
        browserOutTopic: browserOutTopicName,
        localInTopic: localInTopicName,
        nextBrowserSeq: 0,
        nextLocalSeq: 0,
      };
      const connection: PublicWsConnection =
        localClient === undefined
          ? { ...baseConnection, _tag: "Queued" }
          : { ...baseConnection, _tag: "Direct", localClientId: localClient.clientId };
      publicWebSockets.set(connId, connection);
      publicWebSocketCountsBySlug.set(slug, existingCount + 1);
      yield* Effect.addFinalizer(() => Effect.sync(() => unregisterPublicConnection(connection)));

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
      const messageFibers = yield* FiberSet.make<void, GatewayOperationError>();
      if (connection._tag === "Direct") {
        stats.directWebSocketOpens += 1;
        const selectedLocalClient = localClients.get(connection.localClientId);
        if (selectedLocalClient !== undefined) {
          yield* selectedLocalClient.socket.sendFrame(openFrame);
        }
      } else {
        stats.queuedWebSocketOpens += 1;
        yield* FiberSet.run(
          messageFibers,
          startPublicWsOutputPump(connection).pipe(
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
        stats.queueSends += 1;
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
            seq: connection.nextBrowserSeq,
            data: event.data.toString("base64"),
            binary: event.binary,
          };
          connection.nextBrowserSeq += 1;
          yield* FiberSet.run(
            messageFibers,
            sendBrowserWebSocketFrame(connection, frame).pipe(
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
        yield* sendBrowserWebSocketFrame(connection, closeFrame).pipe(
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

  function sendBrowserWebSocketFrame(
    connection: PublicWsConnection,
    frame: WsData | WsClose,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      if (connection._tag === "Direct") {
        const localClient = localClients.get(connection.localClientId);
        if (localClient !== undefined && (yield* localClient.socket.sendFrame(frame))) {
          return;
        }
      }
      yield* queue.send(connection.localInTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
      });
      stats.queueSends += 1;
    });
  }

  function startPublicWsOutputPump(
    connection: PublicWsConnection,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const consumerGroup = wsBrowserOutConsumerGroup(connection.connId);
      while (yield* connection.socket.isOpen) {
        const messages = yield* queue.receive({
          topic: connection.browserOutTopic,
          consumerGroup,
          limit: QUEUE_RECEIVE_LIMIT,
          visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
        });
        stats.queueReceives += 1;
        if (messages.length === 0) {
          yield* Effect.sleep(QUEUE_RECEIVE_WARM_DELAY_MS);
          continue;
        }

        for (const message of messages) {
          const frameResult = parseProtocolFramePayload(message.payload);
          if (Result.isFailure(frameResult)) {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }
          const frame = frameResult.success;
          if (frame.type !== "ws.data" && frame.type !== "ws.close") {
            yield* message.ack;
            stats.queueAcks += 1;
            continue;
          }
          yield* routeWebSocketFrameToBrowser(connection, frame);
          yield* message.ack;
          stats.queueAcks += 1;
          if (frame.type === "ws.close") {
            return;
          }
        }
      }
    });
  }

  function completeOrPublishHttpResponse(
    frame: HttpResponse,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const pending = pendingHttpRequests.get(frame.requestId);
      if (pending !== undefined) {
        yield* Deferred.succeed(pending.result, { _tag: "response", response: frame });
        return;
      }
      yield* queue.send(frame.responseTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      });
      stats.queueSends += 1;
    });
  }

  function routeLocalWebSocketFrame(
    frame: WsData | WsClose,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const publicConnection = publicWebSockets.get(frame.connId);
      if (publicConnection !== undefined) {
        yield* routeWebSocketFrameToBrowser(publicConnection, frame);
        return;
      }
      if (frame.browserOutTopic !== undefined) {
        yield* queue.send(frame.browserOutTopic, frame, {
          idempotencyKey: frame.frameId,
          ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
        });
        stats.queueSends += 1;
      }
    });
  }

  function routeWebSocketFrameToBrowser(
    connection: PublicWsConnection,
    frame: WsData | WsClose,
  ): Effect.Effect<void, GatewayWebSocketWriteError> {
    return Effect.gen(function* () {
      if (frame.type === "ws.data") {
        if (frame.seq < connection.nextLocalSeq) {
          return;
        }
        if (frame.seq > connection.nextLocalSeq) {
          yield* connection.socket.close(1011, "websocket queue sequence gap");
          return;
        }
        connection.nextLocalSeq += 1;
        yield* connection.socket.sendData(Buffer.from(frame.data, "base64"), frame.binary);
        return;
      }

      unregisterPublicConnection(connection);
      yield* connection.socket.close(frame.code, frame.reason);
    });
  }

  function pickLocalClientOnThisInstance(
    slug: string,
  ): Effect.Effect<LocalClientSocket | undefined> {
    return Effect.gen(function* () {
      const clientIds = localClientIdsBySlug.get(slug);
      if (clientIds === undefined) {
        return undefined;
      }
      for (const clientId of clientIds) {
        const client = localClients.get(clientId);
        if (
          client !== undefined &&
          !client.draining &&
          (yield* client.socket.isOpen) &&
          isCurrentLocalClient(client) &&
          client.inFlight < client.capacity
        ) {
          return client;
        }
      }
      return undefined;
    });
  }

  function drainOlderLocalClients(nextClient: LocalClientSocket): void {
    const clientIds = localClientIdsBySlug.get(nextClient.slug);
    if (clientIds === undefined) {
      return;
    }
    for (const clientId of clientIds) {
      const existing = localClients.get(clientId);
      if (
        existing !== undefined &&
        existing.sessionId === nextClient.sessionId &&
        existing.generation < nextClient.generation
      ) {
        existing.draining = true;
      }
    }
  }

  function isCurrentLocalClient(client: LocalClientSocket): boolean {
    const clientIds = localClientIdsBySlug.get(client.slug);
    if (clientIds === undefined) {
      return false;
    }
    for (const clientId of clientIds) {
      const existing = localClients.get(clientId);
      if (
        existing !== undefined &&
        existing.sessionId === client.sessionId &&
        existing.generation > client.generation &&
        !existing.draining
      ) {
        return false;
      }
    }
    return true;
  }

  function releaseDirectHttpRequest(localClient: LocalClientSocket, requestId: string): void {
    if (!localClient.pendingDirectHttpRequests.delete(requestId)) {
      return;
    }
    pendingHttpRequests.delete(requestId);
    localClient.inFlight = Math.max(0, localClient.inFlight - 1);
  }

  function unregisterPublicConnection(connection: PublicWsConnection): void {
    if (!publicWebSockets.delete(connection.connId)) {
      return;
    }
    const count = publicWebSocketCountsBySlug.get(connection.slug) ?? 0;
    if (count <= 1) {
      publicWebSocketCountsBySlug.delete(connection.slug);
    } else {
      publicWebSocketCountsBySlug.set(connection.slug, count - 1);
    }
  }
});

/** Effect service for the scoped Node server owned by the gateway runtime. */
export class GatewayServer extends Context.Service<GatewayServer, Server>()(
  "turbotunnel/gateway/GatewayServer",
) {
  static readonly layer = Layer.effect(
    this,
    makeGatewayServer().pipe(Effect.map(GatewayServer.of)),
  );
}

/** Builds the complete gateway runtime layer while parsing the supplied process environment. */
export const GatewayLive = (env: NodeJS.ProcessEnv) => {
  const baseLayer = Layer.mergeAll(GatewayConfig.layerFromEnv(env), OidcToken.layer);
  const queueLayer = Layer.unwrap(
    GatewayConfig.use((config) =>
      Effect.succeed(config.brokerKind === "memory" ? MemoryQueue.layer : VercelQueue.layer),
    ),
  ).pipe(Layer.provide(baseLayer));
  const dependencies = Layer.mergeAll(baseLayer, queueLayer);
  return GatewayServer.layer.pipe(Layer.provideMerge(dependencies));
};

/** Accepts one raw upgrade and destroys its socket if the owning Effect is interrupted first. */
function acceptUpgrade(
  webSocketServer: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  return Effect.callback<import("ws").WebSocket>((resume) => {
    const onClose = (): void => resume(Effect.interrupt);
    socket.once("close", onClose);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socket.removeListener("close", onClose);
      resume(Effect.succeed(webSocket));
    });
    return Effect.sync(() => {
      socket.removeListener("close", onClose);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  });
}

function closeNodeServer(server: Server): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function writeHttpResponse(response: ServerResponse, frame: HttpResponse): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(frame.status, responseHeadersForBrowser(frame.headers));
  response.end(Buffer.from(frame.body, "base64"));
}

function writePlainResponse(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function writeGatewayStatus(
  response: ServerResponse,
  config: {
    readonly brokerKind: string;
    readonly queueRegion: string;
    readonly baseDomain: string;
  },
  localClients: ReadonlyMap<string, LocalClientSocket>,
  stats: GatewayStats,
  request?: IncomingMessage,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let activeLocalClients = 0;
    for (const client of localClients.values()) {
      if (!client.draining && (yield* client.socket.isOpen)) {
        activeLocalClients += 1;
      }
    }
    const body = gatewayStatus(config, activeLocalClients, stats, yield* Clock.currentTimeMillis);
    if (request?.headers.accept?.includes("application/json")) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(body)}\n`);
      return;
    }

    const text = [
      "Turbotunnel gateway is running.",
      "",
      `Version: ${body.version}`,
      `Base domain: ${body.baseDomain}`,
      `Broker: ${body.broker}`,
      `Queue region: ${body.queueRegion}`,
      `Uptime: ${formatDurationSeconds(body.uptimeSeconds)}`,
      `Active local clients on this instance: ${body.activeLocalClients}`,
      `Direct HTTP requests on this instance: ${body.directHttpRequests}`,
      `Queued HTTP requests on this instance: ${body.queuedHttpRequests}`,
      `Direct WebSocket opens on this instance: ${body.directWebSocketOpens}`,
      `Queued WebSocket opens on this instance: ${body.queuedWebSocketOpens}`,
      `Queue sends on this instance: ${body.queueSends}`,
      `Queue receives on this instance: ${body.queueReceives}`,
      `Queue acks on this instance: ${body.queueAcks}`,
      "",
      "Connect a local app with: tt http <port>",
    ].join("\n");
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${text}\n`);
  });
}

function gatewayStatus(
  config: {
    readonly brokerKind: string;
    readonly queueRegion: string;
    readonly baseDomain: string;
  },
  activeLocalClients: number,
  stats: GatewayStats,
  now: number,
) {
  return Object.fromEntries([
    ["status", "running"],
    ["version", TURBOTUNNEL_VERSION],
    ["baseDomain", config.baseDomain],
    ["broker", config.brokerKind],
    ["queueRegion", config.queueRegion],
    ["uptimeSeconds", Math.round((now - stats.startedAt) / 1000)],
    ["activeLocalClients", activeLocalClients],
    ["directHttpRequests", stats.directHttpRequests],
    ["queuedHttpRequests", stats.queuedHttpRequests],
    ["directWebSocketOpens", stats.directWebSocketOpens],
    ["queuedWebSocketOpens", stats.queuedWebSocketOpens],
    ["queueSends", stats.queueSends],
    ["queueReceives", stats.queueReceives],
    ["queueAcks", stats.queueAcks],
  ] as const);
}

function formatDurationSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function queueReceiveDelay(emptyReceives: number): number {
  if (emptyReceives <= 1) {
    return QUEUE_RECEIVE_HOT_DELAY_MS;
  }
  if (emptyReceives < QUEUE_RECEIVE_COLD_AFTER_EMPTY) {
    return QUEUE_RECEIVE_WARM_DELAY_MS;
  }
  return QUEUE_RECEIVE_COLD_DELAY_MS;
}

type ReadLimitedBodyResult =
  | { readonly _tag: "ok"; readonly value: Buffer }
  | { readonly _tag: "err"; readonly error: ReadLimitedBodyError };

type ReadLimitedBodyError =
  | { readonly reason: "too-large"; readonly limitBytes: number }
  | { readonly reason: "read-failed"; readonly cause: unknown };

function readLimitedBody(
  request: IncomingMessage,
  maxBytes: number,
): Effect.Effect<ReadLimitedBodyResult> {
  return Effect.callback((resume) => {
    const chunks: Array<Buffer> = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (result: ReadLimitedBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resume(Effect.succeed(result));
    };
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        request.pause();
        finish({ _tag: "err", error: { reason: "too-large", limitBytes: maxBytes } });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => finish({ _tag: "ok", value: Buffer.concat(chunks, totalBytes) });
    const onError = (cause: unknown): void =>
      finish({ _tag: "err", error: { reason: "read-failed", cause } });
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    return Effect.sync(cleanup);
  });
}

function isExpired(frame: Frame, now: number): boolean {
  return "deadlineAt" in frame && frame.deadlineAt !== undefined && frame.deadlineAt < now;
}

function hasValidBearerAuth(value: string | undefined, expectedSecret: string): boolean {
  if (value === undefined || !value.startsWith("Bearer ")) {
    return false;
  }
  const tokenBytes = Buffer.from(value.slice("Bearer ".length));
  const expectedBytes = Buffer.from(expectedSecret);
  return (
    tokenBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(tokenBytes, expectedBytes)
  );
}
