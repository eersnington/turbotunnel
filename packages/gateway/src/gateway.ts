import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
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
  type HeaderPair,
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
} from "@turbotunnel/protocol";
import { Effect, Layer, Result } from "effect";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { GatewayConfig } from "./gateway-config.js";
import { MemoryQueue } from "./memory-queue.js";
import { OidcToken } from "./oidc-token.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";
import { VercelQueue } from "./vercel-queue.js";
import { waitForHttpResponseFromQueue } from "./response-waiter.js";

export const GatewayLive = (env: NodeJS.ProcessEnv) => {
  const baseLayer = Layer.mergeAll(GatewayConfig.layerFromEnv(env), OidcToken.layer);
  const queueLayer = Layer.unwrap(
    GatewayConfig.use((config) =>
      Effect.succeed(config.brokerKind === "memory" ? MemoryQueue.layer : VercelQueue.layer),
    ),
  ).pipe(Layer.provide(baseLayer));

  return Layer.mergeAll(baseLayer, queueLayer);
};

type LocalTarget = {
  readonly protocol: "http";
  readonly host: string;
  readonly port: number;
};

type PendingDeliveryAck = {
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (accepted: boolean) => void;
};

type LocalClientSocket = {
  readonly slug: string;
  readonly ws: WebSocket;
  readonly clientId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly target: LocalTarget;
  readonly pendingDeliveryAcks: Map<string, PendingDeliveryAck>;
  readonly pendingDirectHttpRequests: Set<string>;
  inFlight: number;
  capacity: number;
  draining: boolean;
  emptyQueueReceives: number;
};

type PendingHttpRequest = {
  readonly requestId: string;
  readonly responseTopic: string;
  readonly response: ServerResponse;
  readonly localClientId: string;
  readonly timeout: NodeJS.Timeout;
};

type GatewayStats = {
  startedAt: number;
  directHttpRequests: number;
  queuedHttpRequests: number;
  directWebSocketOpens: number;
  queuedWebSocketOpens: number;
  queueReceives: number;
  queueSends: number;
  queueAcks: number;
};

type PublicWsConnection = {
  readonly connId: string;
  readonly slug: string;
  readonly ws: WebSocket;
  readonly browserOutTopic: string;
  readonly localInTopic: string;
  readonly mode: "direct" | "queue";
  readonly localClientId: string | undefined;
  nextBrowserSeq: number;
  nextLocalSeq: number;
};

type GatewayOperationError = QueueAckError | QueueAuthError | QueueReceiveError | QueueSendError;

type CallbackInterrupt = (interruptor?: number | undefined) => void;

type GatewayRequestHeaders = {
  readonly host: string | undefined;
  readonly authorization: string | undefined;
  readonly oidcToken: string | undefined;
  readonly forwardedProto: string;
  readonly secWebSocketProtocols: ReadonlyArray<string>;
};

type GatewayRequestHeadersResult =
  | { readonly _tag: "ok"; readonly value: GatewayRequestHeaders }
  | { readonly _tag: "err"; readonly header: string };

export const makeGatewayServer = Effect.fn("makeGatewayServer")(function* () {
  const config = yield* GatewayConfig;
  const queue = yield* Queue;
  const oidcToken = yield* OidcToken;
  const localClients = new Map<string, LocalClientSocket>();
  const localClientIdsBySlug = new Map<string, Set<string>>();
  const pendingHttpRequests = new Map<string, PendingHttpRequest>();
  const publicWebSockets = new Map<string, PublicWsConnection>();
  const publicWebSocketCountsBySlug = new Map<string, number>();
  const stats: GatewayStats = {
    startedAt: Date.now(),
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
      if (protocols.has(LOCAL_CLIENT_SUBPROTOCOL)) {
        return LOCAL_CLIENT_SUBPROTOCOL;
      }

      return false;
    },
  });

  const server = createServer((request, response) => {
    let interrupt: CallbackInterrupt | undefined;
    const interruptOnClose = (): void => {
      if (!response.writableEnded) {
        interrupt?.();
      }
    };

    interrupt = Effect.runCallback(
      handlePublicHttp(request, response).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("gateway HTTP request failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag }),
            );
            writePlainResponse(
              response,
              503,
              "Gateway queue operation failed. The local tunnel app was not contacted or did not receive the response.",
            );
          }),
        ),
      ),
      {
        onExit() {
          response.removeListener("close", interruptOnClose);
        },
      },
    );
    response.on("close", interruptOnClose);
  });

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head);
  });

  yield* Effect.logInfo("gateway started").pipe(
    Effect.annotateLogs({ brokerKind: config.brokerKind, queueRegion: config.queueRegion }),
  );
  return server;

  function handlePublicHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const headersResult = parseGatewayRequestHeaders(request);
      if (headersResult._tag === "err") {
        writePlainResponse(
          response,
          400,
          `Request contained more than one ${headersResult.header} header. The gateway did not contact the local app.`,
        );
        return;
      }

      const headers = headersResult.value;
      // Refresh the cached token on every request so queue fallback keeps working
      // after Vercel rotates the request-context OIDC token.
      if (headers.oidcToken !== undefined) {
        yield* oidcToken.set(headers.oidcToken);
      }
      if (request.url === "/_turbotunnel/status") {
        writeGatewayStatus(response, config, localClients, stats);
        return;
      }

      const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
      if (slugResult._tag === "err") {
        if (isGatewayRootHost(headers.host, config.baseDomain)) {
          writeGatewayStatus(response, config, localClients, stats);
          return;
        }
        writePlainResponse(response, 404, "Tunnel host was not recognized for this relay domain.");
        return;
      }

      const bodyResult = yield* Effect.promise(() =>
        readLimitedBody(request, MAX_REQUEST_BODY_BYTES),
      );
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

      const slug = slugResult.value;
      const requestTarget = parseTunnelRequestTarget(request.url);
      if (Result.isFailure(requestTarget)) {
        writePlainResponse(response, 400, requestTarget.failure.message);
        return;
      }

      const requestId = `req_${nanoid(12)}`;
      const responseTopicName = httpResponseTopic(requestId);
      const localClient = pickLocalClientOnThisInstance(slug);
      const localHost =
        localClient === undefined
          ? (headers.host ?? "")
          : `${localClient.target.host}:${localClient.target.port}`;
      const frame: HttpRequest = {
        protocolVersion: PROTOCOL_VERSION,
        type: "http.request",
        frameId: `frm_${nanoid(12)}`,
        requestId,
        responseTopic: responseTopicName,
        deadlineAt: Date.now() + PUBLIC_HTTP_TIMEOUT_MS,
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
        forwardHttpDirect(localClient, frame, response);
        return;
      }

      stats.queuedHttpRequests += 1;
      let cancelled = false;
      response.on("close", () => {
        cancelled = !response.writableEnded;
      });

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
        isCancelled: () => cancelled,
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

  function forwardHttpDirect(
    localClient: LocalClientSocket,
    frame: HttpRequest,
    response: ServerResponse,
  ): void {
    const timeout = setTimeout(() => {
      releaseDirectHttpRequest(localClient, frame.requestId);
      writePlainResponse(
        response,
        504,
        "Tunnel request timed out before the local app responded. The local app may still have received the request.",
      );
    }, PUBLIC_HTTP_TIMEOUT_MS);

    pendingHttpRequests.set(frame.requestId, {
      requestId: frame.requestId,
      responseTopic: frame.responseTopic,
      response,
      localClientId: localClient.clientId,
      timeout,
    });
    localClient.inFlight += 1;
    localClient.pendingDirectHttpRequests.add(frame.requestId);
    response.on("close", () => {
      if (!response.writableEnded) {
        clearTimeout(timeout);
        releaseDirectHttpRequest(localClient, frame.requestId);
      }
    });

    if (!sendFrame(localClient.ws, frame)) {
      clearTimeout(timeout);
      releaseDirectHttpRequest(localClient, frame.requestId);
      writePlainResponse(response, 502, "Local tunnel client disconnected before forwarding.");
    }
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const headersResult = parseGatewayRequestHeaders(request);
    if (headersResult._tag === "err") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const headers = headersResult.value;
    // Local tunnel clients connect over WebSocket; capture OIDC here so their
    // queue pump can poll request topics after the upgrade is accepted.
    if (headers.oidcToken !== undefined) {
      Effect.runSync(oidcToken.set(headers.oidcToken));
    }
    const offeredProtocols = new Set(headers.secWebSocketProtocols);
    const isLocalClientAttempt = offeredProtocols.has(LOCAL_CLIENT_SUBPROTOCOL);

    if (isLocalClientAttempt && !hasValidBearerAuth(headers.authorization, config.relaySecret)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      if (isLocalClientAttempt) {
        handleLocalClientSocket(ws, headers);
        return;
      }

      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(
        handlePublicWebSocket(ws, request, headers).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logError("public WebSocket setup failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag }),
              );
              ws.close(1011, "gateway queue operation failed");
            }),
          ),
        ),
        {
          onExit() {
            if (interrupt !== undefined) {
              interrupt = undefined;
            }
          },
        },
      );
    });
  }

  function handleLocalClientSocket(ws: WebSocket, headers: GatewayRequestHeaders): void {
    const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
    if (slugResult._tag === "err") {
      ws.close(1008, "invalid tunnel host");
      return;
    }

    const expectedSlug = slugResult.value;
    const activeEffects = new Set<CallbackInterrupt>();
    let registered: LocalClientSocket | undefined;

    ws.on("message", (data) => {
      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(
        handleLocalClientMessage(data).pipe(
          Effect.catch((error) =>
            Effect.logError("local client message handling failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag }),
            ),
          ),
        ),
        {
          onExit() {
            if (interrupt !== undefined) {
              activeEffects.delete(interrupt);
            }
          },
        },
      );
      activeEffects.add(interrupt);
    });

    ws.on("close", () => {
      for (const interrupt of activeEffects) {
        interrupt();
      }
      activeEffects.clear();

      if (registered === undefined) {
        return;
      }

      registered.draining = true;
      localClients.delete(registered.clientId);
      localClientIdsBySlug.get(registered.slug)?.delete(registered.clientId);
      for (const pending of registered.pendingDeliveryAcks.values()) {
        clearTimeout(pending.timeout);
        pending.resolve(false);
      }
      registered.pendingDeliveryAcks.clear();
      for (const requestId of registered.pendingDirectHttpRequests) {
        const pending = pendingHttpRequests.get(requestId);
        if (pending !== undefined) {
          clearTimeout(pending.timeout);
          writePlainResponse(
            pending.response,
            502,
            "Local tunnel client disconnected before the local app responded.",
          );
        }
        pendingHttpRequests.delete(requestId);
      }
      registered.pendingDirectHttpRequests.clear();
      registered.inFlight = 0;
      registered = undefined;
    });

    function handleLocalClientMessage(data: RawData): Effect.Effect<void, GatewayOperationError> {
      return Effect.gen(function* () {
        const frameResult = parseProtocolFrameJson(
          (Buffer.isBuffer(data)
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Buffer.concat(data)
          ).toString("utf8"),
        );
        if (Result.isFailure(frameResult)) {
          yield* Effect.logWarning("closing local client after invalid frame").pipe(
            Effect.annotateLogs({ reason: frameResult.failure.reason }),
          );
          ws.close(1002, "invalid protocol frame");
          return;
        }

        const frame = frameResult.success;
        switch (frame.type) {
          case "local.hello": {
            if (registered !== undefined || frame.slug !== expectedSlug) {
              ws.close(1008, "invalid local client hello");
              return;
            }

            const localClient: LocalClientSocket = {
              slug: frame.slug,
              ws,
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
            let interrupt: CallbackInterrupt | undefined;
            interrupt = Effect.runCallback(
              startLocalQueuePump(localClient, activeEffects).pipe(
                Effect.catch((error) =>
                  Effect.logError("local queue pump failed").pipe(
                    Effect.annotateLogs({ errorTag: error._tag, slug: localClient.slug }),
                  ),
                ),
              ),
              {
                onExit() {
                  if (interrupt !== undefined) {
                    activeEffects.delete(interrupt);
                  }
                },
              },
            );
            activeEffects.add(interrupt);
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
              ws.close(1008, "invalid local client heartbeat");
            }
            return;
          }

          case "delivery.ack": {
            registered?.pendingDeliveryAcks.get(frame.ackFrameId)?.resolve(true);
            const pending = registered?.pendingDeliveryAcks.get(frame.ackFrameId);
            if (pending !== undefined) {
              clearTimeout(pending.timeout);
              registered?.pendingDeliveryAcks.delete(frame.ackFrameId);
            }
            return;
          }

          case "delivery.reject": {
            registered?.pendingDeliveryAcks.get(frame.rejectFrameId)?.resolve(false);
            const pending = registered?.pendingDeliveryAcks.get(frame.rejectFrameId);
            if (pending !== undefined) {
              clearTimeout(pending.timeout);
              registered?.pendingDeliveryAcks.delete(frame.rejectFrameId);
            }
            return;
          }

          case "http.response": {
            yield* completeOrPublishHttpResponse(frame);
            return;
          }

          case "ws.data": {
            yield* routeLocalWebSocketData(frame);
            return;
          }

          case "ws.close": {
            yield* routeLocalWebSocketClose(frame);
            return;
          }

          case "error":
          case "http.request":
          case "ws.open": {
            ws.close(1008, "frame type is not accepted from local client");
            return;
          }
        }
      });
    }
  }

  function startLocalQueuePump(
    localClient: LocalClientSocket,
    activeEffects: Set<CallbackInterrupt>,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const topic = requestTopic(localClient.slug);
      const consumerGroup = localConsumerGroup(localClient.slug);

      while (localClient.ws.readyState === WebSocket.OPEN && !localClient.draining) {
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
          if (Result.isFailure(frameResult) || isExpired(frameResult.success)) {
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

          const accepted = yield* Effect.promise(() =>
            sendFrameToLocalClientAndWaitForAck(localClient, frame),
          );
          if (accepted) {
            yield* message.ack;
            stats.queueAcks += 1;
            if (frame.type === "ws.open") {
              let interrupt: CallbackInterrupt | undefined;
              interrupt = Effect.runCallback(
                startLocalWsInputPump(localClient, frame).pipe(
                  Effect.catch((error) =>
                    Effect.logError("local WebSocket input pump failed").pipe(
                      Effect.annotateLogs({ errorTag: error._tag, slug: localClient.slug }),
                    ),
                  ),
                ),
                {
                  onExit() {
                    if (interrupt !== undefined) {
                      activeEffects.delete(interrupt);
                    }
                  },
                },
              );
              activeEffects.add(interrupt);
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

      while (localClient.ws.readyState === WebSocket.OPEN && !localClient.draining) {
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
          if (Result.isFailure(frameResult) || isExpired(frameResult.success)) {
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

          const accepted = yield* Effect.promise(() =>
            sendFrameToLocalClientAndWaitForAck(localClient, frame),
          );
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

  function handlePublicWebSocket(
    ws: WebSocket,
    request: IncomingMessage,
    headers: GatewayRequestHeaders,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
      if (slugResult._tag === "err") {
        ws.close(1008, "invalid tunnel host");
        return;
      }

      const slug = slugResult.value;
      const existingCount = publicWebSocketCountsBySlug.get(slug) ?? 0;
      if (existingCount >= MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL) {
        ws.close(1013, "too many websocket connections for tunnel");
        return;
      }

      const connId = `ws_${nanoid(12)}`;
      const requestTarget = parseTunnelRequestTarget(request.url);
      if (Result.isFailure(requestTarget)) {
        ws.close(1008, requestTarget.failure.message);
        return;
      }

      const browserOutTopicName = wsBrowserOutTopic(connId);
      const localInTopicName = wsLocalInTopic(connId);
      const localClient = pickLocalClientOnThisInstance(slug);
      const activeEffects = new Set<CallbackInterrupt>();
      const publicConnection: PublicWsConnection = {
        connId,
        slug,
        ws,
        browserOutTopic: browserOutTopicName,
        localInTopic: localInTopicName,
        mode: localClient === undefined ? "queue" : "direct",
        localClientId: localClient?.clientId,
        nextBrowserSeq: 0,
        nextLocalSeq: 0,
      };
      publicWebSockets.set(connId, publicConnection);
      publicWebSocketCountsBySlug.set(slug, existingCount + 1);

      ws.on("message", (data, isBinary) => {
        const frame: WsData = {
          protocolVersion: PROTOCOL_VERSION,
          type: "ws.data",
          frameId: `frm_${nanoid(12)}`,
          connId,
          localInTopic: localInTopicName,
          seq: publicConnection.nextBrowserSeq,
          data: (Buffer.isBuffer(data)
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Buffer.concat(data)
          ).toString("base64"),
          binary: isBinary,
        };
        publicConnection.nextBrowserSeq += 1;
        let interrupt: CallbackInterrupt | undefined;
        interrupt = Effect.runCallback(
          sendBrowserWebSocketFrame(publicConnection, frame).pipe(
            Effect.catch((error) =>
              Effect.logError("browser WebSocket frame forwarding failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag, slug }),
              ),
            ),
          ),
          {
            onExit() {
              if (interrupt !== undefined) {
                activeEffects.delete(interrupt);
              }
            },
          },
        );
        activeEffects.add(interrupt);
      });

      ws.on("close", (code, reason) => {
        publicWebSockets.delete(connId);
        decrementPublicWebSocketCount(slug);
        const frame: WsClose = {
          protocolVersion: PROTOCOL_VERSION,
          type: "ws.close",
          frameId: `frm_${nanoid(12)}`,
          connId,
          localInTopic: localInTopicName,
          code,
          reason: reason.toString("utf8"),
        };
        for (const interrupt of activeEffects) {
          interrupt();
        }
        activeEffects.clear();

        let closeInterrupt: CallbackInterrupt | undefined;
        closeInterrupt = Effect.runCallback(
          sendBrowserWebSocketFrame(publicConnection, frame).pipe(
            Effect.catch((error) =>
              Effect.logError("browser WebSocket close forwarding failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag, slug }),
              ),
            ),
          ),
          {
            onExit() {
              if (closeInterrupt !== undefined) {
                activeEffects.delete(closeInterrupt);
              }
            },
          },
        );
        activeEffects.add(closeInterrupt);
      });

      const openFrame: WsOpen = {
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.open",
        frameId: `frm_${nanoid(12)}`,
        connId,
        browserOutTopic: browserOutTopicName,
        localInTopic: localInTopicName,
        deadlineAt: Date.now() + PUBLIC_HTTP_TIMEOUT_MS,
        path: requestTarget.success.path,
        headers: [...publicWebSocketHeaders(request.rawHeaders)],
      };

      if (localClient !== undefined) {
        stats.directWebSocketOpens += 1;
        sendFrame(localClient.ws, openFrame);
        return;
      }

      stats.queuedWebSocketOpens += 1;
      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(
        startPublicWsOutputPump(publicConnection).pipe(
          Effect.catch((error) =>
            Effect.logError("public WebSocket output pump failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag, slug }),
            ),
          ),
        ),
        {
          onExit() {
            if (interrupt !== undefined) {
              activeEffects.delete(interrupt);
            }
          },
        },
      );
      activeEffects.add(interrupt);
      yield* queue.send(requestTopic(slug), openFrame, {
        idempotencyKey: openFrame.frameId,
        ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
      });
      stats.queueSends += 1;
    });
  }

  function sendBrowserWebSocketFrame(
    connection: PublicWsConnection,
    frame: WsData | WsClose,
  ): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      if (connection.mode === "direct" && connection.localClientId !== undefined) {
        const localClient = localClients.get(connection.localClientId);
        if (localClient !== undefined && sendFrame(localClient.ws, frame)) {
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

      while (connection.ws.readyState === WebSocket.OPEN) {
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

          routeWebSocketFrameToBrowser(connection, frame);
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
        clearTimeout(pending.timeout);
        releaseDirectHttpRequestById(pending.localClientId, frame.requestId);
        writeHttpResponse(pending.response, frame);
        return;
      }

      yield* queue.send(frame.responseTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      });
      stats.queueSends += 1;
    });
  }

  function routeLocalWebSocketData(frame: WsData): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const publicConnection = publicWebSockets.get(frame.connId);
      if (publicConnection !== undefined) {
        routeWebSocketFrameToBrowser(publicConnection, frame);
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

  function routeLocalWebSocketClose(frame: WsClose): Effect.Effect<void, GatewayOperationError> {
    return Effect.gen(function* () {
      const publicConnection = publicWebSockets.get(frame.connId);
      if (publicConnection !== undefined) {
        routeWebSocketFrameToBrowser(publicConnection, frame);
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
  ): void {
    if (frame.type === "ws.data") {
      if (frame.seq < connection.nextLocalSeq) {
        return;
      }
      if (frame.seq > connection.nextLocalSeq) {
        connection.ws.close(1011, "websocket queue sequence gap");
        return;
      }
      connection.nextLocalSeq += 1;
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(Buffer.from(frame.data, "base64"), { binary: frame.binary });
      }
      return;
    }

    publicWebSockets.delete(frame.connId);
    decrementPublicWebSocketCount(connection.slug);
    connection.ws.close(frame.code, frame.reason);
  }

  function pickLocalClientOnThisInstance(slug: string): LocalClientSocket | undefined {
    const clientIds = localClientIdsBySlug.get(slug);
    if (clientIds === undefined) {
      return undefined;
    }

    for (const clientId of clientIds) {
      const client = localClients.get(clientId);
      if (
        client !== undefined &&
        !client.draining &&
        client.ws.readyState === WebSocket.OPEN &&
        isCurrentLocalClient(client) &&
        client.inFlight < client.capacity
      ) {
        return client;
      }
    }

    return undefined;
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

  function releaseDirectHttpRequestById(localClientId: string, requestId: string): void {
    const localClient = localClients.get(localClientId);
    if (localClient === undefined) {
      pendingHttpRequests.delete(requestId);
      return;
    }

    releaseDirectHttpRequest(localClient, requestId);
  }

  function decrementPublicWebSocketCount(slug: string): void {
    const count = publicWebSocketCountsBySlug.get(slug) ?? 0;
    if (count <= 1) {
      publicWebSocketCountsBySlug.delete(slug);
      return;
    }

    publicWebSocketCountsBySlug.set(slug, count - 1);
  }
});

function sendFrameToLocalClientAndWaitForAck(
  localClient: LocalClientSocket,
  frame: TunnelRequestFrame,
): Promise<boolean> {
  if (!sendFrame(localClient.ws, frame)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      localClient.pendingDeliveryAcks.delete(frame.frameId);
      resolve(false);
    }, LOCAL_CLIENT_ACK_TIMEOUT_MS);

    localClient.pendingDeliveryAcks.set(frame.frameId, { timeout, resolve });
  });
}

function writeHttpResponse(response: ServerResponse, frame: HttpResponse): void {
  if (response.writableEnded) {
    return;
  }

  response.writeHead(frame.status, responseHeadersForBrowser(frame.headers));
  response.end(Buffer.from(frame.body, "base64"));
}

function sendFrame(ws: WebSocket, frame: Frame): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(frame));
  return true;
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
): void {
  const activeClients = Array.from(localClients.values()).filter(
    (client) => !client.draining && client.ws.readyState === WebSocket.OPEN,
  );
  const body = [
    "Turbotunnel gateway is running.",
    "",
    `Version: ${TURBOTUNNEL_VERSION}`,
    `Base domain: ${config.baseDomain}`,
    `Broker: ${config.brokerKind}`,
    `Queue region: ${config.queueRegion}`,
    `Uptime: ${formatDurationSeconds(Math.round((Date.now() - stats.startedAt) / 1000))}`,
    `Active local clients on this instance: ${activeClients.length}`,
    `Direct HTTP requests on this instance: ${stats.directHttpRequests}`,
    `Queued HTTP requests on this instance: ${stats.queuedHttpRequests}`,
    `Direct WebSocket opens on this instance: ${stats.directWebSocketOpens}`,
    `Queued WebSocket opens on this instance: ${stats.queuedWebSocketOpens}`,
    `Queue sends on this instance: ${stats.queueSends}`,
    `Queue receives on this instance: ${stats.queueReceives}`,
    `Queue acks on this instance: ${stats.queueAcks}`,
    "",
    "Connect a local app with: tt http <port>",
  ].join("\n");

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${body}\n`);
}

function formatDurationSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
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
): Promise<ReadLimitedBodyResult> {
  return new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: ReadLimitedBodyResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      resolve(result);
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

    const onEnd = (): void => {
      finish({ _tag: "ok", value: Buffer.concat(chunks, totalBytes) });
    };

    const onError = (cause: unknown): void => {
      finish({ _tag: "err", error: { reason: "read-failed", cause } });
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
]);

const REQUEST_HEADERS_OVERRIDDEN_BY_GATEWAY = new Set([
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-turbotunnel-request-id",
]);

function requestHeadersForLocalApp(input: {
  readonly rawHeaders: ReadonlyArray<string>;
  readonly localHost: string;
  readonly forwardedHost: string;
  readonly forwardedProto: string;
  readonly requestId: string;
}): ReadonlyArray<HeaderPair> {
  const headers: Array<HeaderPair> = [];

  for (let index = 0; index + 1 < input.rawHeaders.length; index += 2) {
    const rawName = input.rawHeaders[index];
    const rawValue = input.rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined) {
      continue;
    }

    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || REQUEST_HEADERS_OVERRIDDEN_BY_GATEWAY.has(name)) {
      continue;
    }

    headers.push([name, rawValue]);
  }

  headers.push(["host", input.localHost]);
  headers.push(["x-forwarded-host", input.forwardedHost]);
  headers.push(["x-forwarded-proto", input.forwardedProto]);
  headers.push(["x-turbotunnel-request-id", input.requestId]);

  return headers;
}

function publicWebSocketHeaders(rawHeaders: ReadonlyArray<string>): ReadonlyArray<HeaderPair> {
  const projected: Array<HeaderPair> = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const rawValue = rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined) {
      continue;
    }

    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === "host") {
      continue;
    }

    projected.push([name, rawValue]);
  }

  return projected;
}

function responseHeadersForBrowser(headers: ReadonlyArray<HeaderPair>): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  const grouped = new Map<string, Array<string>>();

  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }

    const existing = grouped.get(name);
    if (existing === undefined) {
      grouped.set(name, [value]);
    } else {
      existing.push(value);
    }
  }

  for (const [name, values] of grouped) {
    output[name] = values.length === 1 ? values[0] : values;
  }

  return output;
}

function parseGatewayRequestHeaders(request: IncomingMessage): GatewayRequestHeadersResult {
  let host: string | undefined;
  let authorization: string | undefined;
  let oidcToken: string | undefined;
  const forwardedProtoValues: Array<string> = [];
  const secWebSocketProtocols: Array<string> = [];

  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (rawName === undefined || value === undefined) {
      continue;
    }

    const name = rawName.toLowerCase();
    switch (name) {
      case "host": {
        if (host !== undefined) {
          return { _tag: "err", header: "Host" };
        }
        host = value;
        break;
      }
      case "authorization": {
        if (authorization !== undefined) {
          return { _tag: "err", header: "Authorization" };
        }
        authorization = value;
        break;
      }
      case "x-vercel-oidc-token": {
        if (oidcToken !== undefined) {
          return { _tag: "err", header: "X-Vercel-OIDC-Token" };
        }
        oidcToken = value;
        break;
      }
      case "x-forwarded-proto": {
        forwardedProtoValues.push(value);
        break;
      }
      case "sec-websocket-protocol": {
        for (const protocol of value.split(",")) {
          const trimmed = protocol.trim();
          if (trimmed.length > 0) {
            secWebSocketProtocols.push(trimmed);
          }
        }
        break;
      }
    }
  }

  return {
    _tag: "ok",
    value: {
      host,
      authorization,
      oidcToken,
      forwardedProto: parseForwardedProto(forwardedProtoValues),
      secWebSocketProtocols,
    },
  };
}

function parseForwardedProto(values: ReadonlyArray<string>): string {
  for (const value of values) {
    const [first] = value.split(",", 1);
    const protocol = first?.trim();
    if (protocol !== undefined && protocol.length > 0) {
      return protocol;
    }
  }

  return "https";
}

type ExtractSlugResult =
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly reason: "missing-host" | "wrong-domain" | "invalid-slug" };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_TOKEN = "{slug}";

function extractSlugFromHost(
  hostHeader: string | undefined,
  baseDomain: string,
): ExtractSlugResult {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return { _tag: "err", reason: "missing-host" };
  }

  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  const baseHost = baseDomain.trim().toLowerCase().replace(/:\d+$/, "");

  if (baseHost.includes(SLUG_TOKEN)) {
    return extractSlugFromPattern(host, baseHost);
  }

  const suffix = `.${baseHost}`;

  if (!host.endsWith(suffix)) {
    return { _tag: "err", reason: "wrong-domain" };
  }

  const slug = host.slice(0, -suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", reason: "invalid-slug" };
  }

  return { _tag: "ok", value: slug };
}

function isGatewayRootHost(hostHeader: string | undefined, baseDomain: string): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return true;
  }

  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  const baseHost = baseDomain.trim().toLowerCase().replace(/:\d+$/, "");
  return !baseHost.includes(SLUG_TOKEN) && host === baseHost;
}

function extractSlugFromPattern(host: string, pattern: string): ExtractSlugResult {
  const tokenIndex = pattern.indexOf(SLUG_TOKEN);
  const prefix = pattern.slice(0, tokenIndex);
  const suffix = pattern.slice(tokenIndex + SLUG_TOKEN.length);

  if (!host.startsWith(prefix) || !host.endsWith(suffix)) {
    return { _tag: "err", reason: "wrong-domain" };
  }

  const slug = host.slice(prefix.length, host.length - suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", reason: "invalid-slug" };
  }

  return { _tag: "ok", value: slug };
}

function isExpired(frame: Frame): boolean {
  return "deadlineAt" in frame && frame.deadlineAt !== undefined && frame.deadlineAt < Date.now();
}

function hasValidBearerAuth(value: string | undefined, expectedSecret: string): boolean {
  if (value === undefined || !value.startsWith("Bearer ")) {
    return false;
  }

  const token = value.slice("Bearer ".length);
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expectedSecret);
  if (tokenBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }

  return timingSafeEqual(tokenBytes, expectedBytes);
}
