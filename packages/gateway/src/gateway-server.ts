import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  httpResponseTopic,
  isTunnelRequestFrame,
  LOCAL_CLIENT_ACK_TIMEOUT_MS,
  LOCAL_CLIENT_SUBPROTOCOL,
  localConsumerGroup,
  MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL,
  MAX_REQUEST_BODY_BYTES,
  parseProtocolFrameJson,
  parseProtocolFramePayload,
  PROTOCOL_VERSION,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_REQUEST_TTL_SECONDS,
  QUEUE_RESPONSE_TTL_SECONDS,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  requestTopic,
  type Frame,
  type HttpRequest,
  type HttpResponse,
  type TunnelRequestFrame,
  type WsClose,
  type WsData,
  type WsOpen,
  wsBrowserOutConsumerGroup,
  wsBrowserOutTopic,
  wsLocalInConsumerGroup,
  wsLocalInTopic,
} from "@repo/turbotunnel-protocol";
import { Result } from "effect";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { Broker } from "./broker.js";
import { readLimitedBody } from "./body.js";
import type { GatewayConfig } from "./config.js";
import {
  forwardedProto,
  publicWebSocketHeaders,
  requestHeadersForLocalApp,
  responseHeadersForBrowser,
} from "./headers.js";
import { MemoryQueueBroker } from "./memory-queue-broker.js";
import { extractSlugFromHost } from "./slug.js";
import { VercelQueueBroker } from "./vercel-queue-broker.js";
import { waitForHttpResponseFromQueue } from "./response-waiter.js";

type CreateGatewayServerInput = {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly broker?: Broker;
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
  readonly target: LocalTarget;
  readonly pendingDeliveryAcks: Map<string, PendingDeliveryAck>;
  inFlight: number;
  capacity: number;
  draining: boolean;
};

type PendingHttpRequest = {
  readonly requestId: string;
  readonly responseTopic: string;
  readonly response: ServerResponse;
  readonly timeout: NodeJS.Timeout;
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

export async function createGatewayServer(input: CreateGatewayServerInput): Promise<Server> {
  const { config, logger } = input;
  // Queue REST calls need Vercel OIDC auth. Runtime requests provide it as a
  // header, including WebSocket upgrades, not as process.env.VERCEL_OIDC_TOKEN.
  let latestOidcToken: string | undefined;
  const broker = input.broker ?? createBroker(config, () => latestOidcToken);
  const localClients = new Map<string, LocalClientSocket>();
  const localClientIdsBySlug = new Map<string, Set<string>>();
  const pendingHttpRequests = new Map<string, PendingHttpRequest>();
  const publicWebSockets = new Map<string, PublicWsConnection>();
  const publicWebSocketCountsBySlug = new Map<string, number>();

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
    observePromise(handlePublicHttp(request, response), logger, "handlePublicHttp");
  });

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head);
  });

  logger.info(
    { brokerKind: config.brokerKind, queueRegion: config.queueRegion },
    "gateway started",
  );
  return server;

  async function handlePublicHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // Refresh the cached token on every request so queue fallback keeps working
    // after Vercel rotates the request-context OIDC token.
    latestOidcToken = oidcTokenFromRequest(request) ?? latestOidcToken;
    const hostHeader = firstHeaderValue(request.headers.host);
    const slugResult = extractSlugFromHost(hostHeader, config.baseDomain);
    if (slugResult._tag === "err") {
      writePlainResponse(response, 404, "Tunnel host was not recognized for this relay domain.");
      return;
    }

    const bodyResult = await readLimitedBody(request, MAX_REQUEST_BODY_BYTES);
    if (bodyResult._tag === "err") {
      writePlainResponse(
        response,
        bodyResult.error._tag === "BodyTooLargeError" ? 413 : 400,
        bodyResult.error._tag === "BodyTooLargeError"
          ? "Request body is larger than the tunnel limit. The local app was not contacted."
          : "Request body could not be read. The local app was not contacted.",
      );
      return;
    }

    const slug = slugResult.value;
    const requestId = `req_${nanoid(12)}`;
    const responseTopicName = httpResponseTopic(requestId);
    const localClient = pickLocalClientOnThisInstance(slug);
    const localHost =
      localClient === undefined
        ? (hostHeader ?? "")
        : `${localClient.target.host}:${localClient.target.port}`;
    const frame: HttpRequest = {
      protocolVersion: PROTOCOL_VERSION,
      type: "http.request",
      frameId: `frm_${nanoid(12)}`,
      requestId,
      responseTopic: responseTopicName,
      deadlineAt: Date.now() + PUBLIC_HTTP_TIMEOUT_MS,
      method: request.method ?? "GET",
      path: request.url?.startsWith("/") === true ? request.url : "/",
      headers: [
        ...requestHeadersForLocalApp({
          headers: request.headers,
          localHost,
          forwardedHost: hostHeader ?? "",
          forwardedProto: forwardedProto(request.headers),
          requestId,
        }),
      ],
      body: bodyResult.value.toString("base64"),
    };

    if (localClient !== undefined) {
      forwardHttpDirect(localClient, frame, response);
      return;
    }

    let cancelled = false;
    response.on("close", () => {
      cancelled = !response.writableEnded;
    });

    await broker.send(requestTopic(slug), frame, {
      idempotencyKey: frame.frameId,
      ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
    });

    const result = await waitForHttpResponseFromQueue({
      broker,
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
  }

  function forwardHttpDirect(
    localClient: LocalClientSocket,
    frame: HttpRequest,
    response: ServerResponse,
  ): void {
    const timeout = setTimeout(() => {
      pendingHttpRequests.delete(frame.requestId);
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
      timeout,
    });
    response.on("close", () => {
      if (!response.writableEnded) {
        clearTimeout(timeout);
        pendingHttpRequests.delete(frame.requestId);
      }
    });

    if (!sendFrame(localClient.ws, frame)) {
      clearTimeout(timeout);
      pendingHttpRequests.delete(frame.requestId);
      writePlainResponse(response, 502, "Local tunnel client disconnected before forwarding.");
    }
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Local tunnel clients connect over WebSocket; capture OIDC here so their
    // queue pump can poll request topics after the upgrade is accepted.
    latestOidcToken = oidcTokenFromRequest(request) ?? latestOidcToken;
    const offeredProtocols = parseSubprotocolHeader(request.headers["sec-websocket-protocol"]);
    const isLocalClientAttempt = offeredProtocols.has(LOCAL_CLIENT_SUBPROTOCOL);

    if (
      isLocalClientAttempt &&
      !hasValidBearerAuth(request.headers.authorization, config.relaySecret)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      if (isLocalClientAttempt) {
        handleLocalClientSocket(ws, request);
        return;
      }

      observePromise(handlePublicWebSocket(ws, request), logger, "handlePublicWebSocket");
    });
  }

  function handleLocalClientSocket(ws: WebSocket, request: IncomingMessage): void {
    const slugResult = extractSlugFromHost(
      firstHeaderValue(request.headers.host),
      config.baseDomain,
    );
    if (slugResult._tag === "err") {
      ws.close(1008, "invalid tunnel host");
      return;
    }

    const expectedSlug = slugResult.value;
    let registered: LocalClientSocket | undefined;

    ws.on("message", (data) => {
      observePromise(handleLocalClientMessage(data), logger, "handleLocalClientMessage");
    });

    ws.on("close", () => {
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
      registered = undefined;
    });

    async function handleLocalClientMessage(data: RawData): Promise<void> {
      const textResult = rawDataToText(data);
      if (textResult._tag === "err") {
        ws.close(1003, "protocol frames must be text");
        return;
      }

      const frameResult = parseProtocolFrameJson(textResult.value);
      if (Result.isFailure(frameResult)) {
        logger.warn(
          { reason: frameResult.failure.reason },
          "closing local client after invalid frame",
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
            target: frame.target,
            pendingDeliveryAcks: new Map(),
            inFlight: 0,
            capacity: 32,
            draining: false,
          };

          registered = localClient;
          localClients.set(localClient.clientId, localClient);
          const clientIds = localClientIdsBySlug.get(localClient.slug) ?? new Set<string>();
          clientIds.add(localClient.clientId);
          localClientIdsBySlug.set(localClient.slug, clientIds);
          observePromise(startLocalQueuePump(localClient), logger, "startLocalQueuePump");
          logger.info(
            { slug: localClient.slug, localClientId: localClient.clientId },
            "local tunnel client registered",
          );
          return;
        }

        case "local.heartbeat": {
          if (
            registered === undefined ||
            registered.clientId !== frame.localClientId ||
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
          completeOrPublishHttpResponse(frame);
          return;
        }

        case "ws.data": {
          await routeLocalWebSocketData(frame);
          return;
        }

        case "ws.close": {
          await routeLocalWebSocketClose(frame);
          return;
        }

        case "error":
        case "http.request":
        case "ws.open": {
          ws.close(1008, "frame type is not accepted from local client");
          return;
        }
      }
    }
  }

  async function startLocalQueuePump(localClient: LocalClientSocket): Promise<void> {
    const topic = requestTopic(localClient.slug);
    const consumerGroup = localConsumerGroup(localClient.slug);

    while (localClient.ws.readyState === WebSocket.OPEN && !localClient.draining) {
      const messages = await broker.receive<unknown>({
        topic,
        consumerGroup,
        limit: QUEUE_RECEIVE_LIMIT,
        visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      });

      if (messages.length === 0) {
        await sleep(100);
        continue;
      }

      for (const message of messages) {
        const frameResult = parseProtocolFramePayload(message.payload);
        if (Result.isFailure(frameResult) || isExpired(frameResult.success)) {
          await message.ack();
          continue;
        }

        const frame = frameResult.success;
        if (!isTunnelRequestFrame(frame)) {
          await message.ack();
          continue;
        }

        const accepted = await sendFrameToLocalClientAndWaitForAck(localClient, frame);
        if (accepted) {
          await message.ack();
          if (frame.type === "ws.open") {
            observePromise(
              startLocalWsInputPump(localClient, frame),
              logger,
              "startLocalWsInputPump",
            );
          }
        }
      }
    }
  }

  async function startLocalWsInputPump(
    localClient: LocalClientSocket,
    openFrame: WsOpen,
  ): Promise<void> {
    const consumerGroup = wsLocalInConsumerGroup(openFrame.connId);

    while (localClient.ws.readyState === WebSocket.OPEN && !localClient.draining) {
      const messages = await broker.receive<unknown>({
        topic: openFrame.localInTopic,
        consumerGroup,
        limit: QUEUE_RECEIVE_LIMIT,
        visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      });

      if (messages.length === 0) {
        await sleep(100);
        continue;
      }

      for (const message of messages) {
        const frameResult = parseProtocolFramePayload(message.payload);
        if (Result.isFailure(frameResult) || isExpired(frameResult.success)) {
          await message.ack();
          continue;
        }

        const frame = frameResult.success;
        if (frame.type !== "ws.data" && frame.type !== "ws.close") {
          await message.ack();
          continue;
        }

        const accepted = await sendFrameToLocalClientAndWaitForAck(localClient, frame);
        if (accepted) {
          await message.ack();
        }
        if (frame.type === "ws.close") {
          return;
        }
      }
    }
  }

  async function handlePublicWebSocket(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const slugResult = extractSlugFromHost(
      firstHeaderValue(request.headers.host),
      config.baseDomain,
    );
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
    const browserOutTopicName = wsBrowserOutTopic(connId);
    const localInTopicName = wsLocalInTopic(connId);
    const localClient = pickLocalClientOnThisInstance(slug);
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
      const bytes = rawDataToBytes(data);
      const frame: WsData = {
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.data",
        frameId: `frm_${nanoid(12)}`,
        connId,
        localInTopic: localInTopicName,
        seq: publicConnection.nextBrowserSeq,
        data: bytes.toString("base64"),
        binary: isBinary,
      };
      publicConnection.nextBrowserSeq += 1;
      observePromise(
        sendBrowserWebSocketFrame(publicConnection, frame),
        logger,
        "sendBrowserWebSocketFrame",
      );
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
      observePromise(
        sendBrowserWebSocketFrame(publicConnection, frame),
        logger,
        "sendBrowserWebSocketClose",
      );
    });

    const openFrame: WsOpen = {
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.open",
      frameId: `frm_${nanoid(12)}`,
      connId,
      browserOutTopic: browserOutTopicName,
      localInTopic: localInTopicName,
      deadlineAt: Date.now() + PUBLIC_HTTP_TIMEOUT_MS,
      path: request.url?.startsWith("/") === true ? request.url : "/",
      headers: [...publicWebSocketHeaders(request.headers)],
    };

    if (localClient !== undefined) {
      sendFrame(localClient.ws, openFrame);
      return;
    }

    observePromise(startPublicWsOutputPump(publicConnection), logger, "startPublicWsOutputPump");
    await broker.send(requestTopic(slug), openFrame, {
      idempotencyKey: openFrame.frameId,
      ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
    });
  }

  async function sendBrowserWebSocketFrame(
    connection: PublicWsConnection,
    frame: WsData | WsClose,
  ): Promise<void> {
    if (connection.mode === "direct" && connection.localClientId !== undefined) {
      const localClient = localClients.get(connection.localClientId);
      if (localClient !== undefined && sendFrame(localClient.ws, frame)) {
        return;
      }
    }

    await broker.send(connection.localInTopic, frame, {
      idempotencyKey: frame.frameId,
      ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
    });
  }

  async function startPublicWsOutputPump(connection: PublicWsConnection): Promise<void> {
    const consumerGroup = wsBrowserOutConsumerGroup(connection.connId);

    while (connection.ws.readyState === WebSocket.OPEN) {
      const messages = await broker.receive<unknown>({
        topic: connection.browserOutTopic,
        consumerGroup,
        limit: QUEUE_RECEIVE_LIMIT,
        visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      });

      if (messages.length === 0) {
        await sleep(100);
        continue;
      }

      for (const message of messages) {
        const frameResult = parseProtocolFramePayload(message.payload);
        if (Result.isFailure(frameResult)) {
          await message.ack();
          continue;
        }

        const frame = frameResult.success;
        if (frame.type !== "ws.data" && frame.type !== "ws.close") {
          await message.ack();
          continue;
        }

        routeWebSocketFrameToBrowser(connection, frame);
        await message.ack();
        if (frame.type === "ws.close") {
          return;
        }
      }
    }
  }

  function completeOrPublishHttpResponse(frame: HttpResponse): void {
    const pending = pendingHttpRequests.get(frame.requestId);
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      pendingHttpRequests.delete(frame.requestId);
      writeHttpResponse(pending.response, frame);
      return;
    }

    observePromise(
      broker.send(frame.responseTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      }),
      logger,
      "publishHttpResponse",
    );
  }

  async function routeLocalWebSocketData(frame: WsData): Promise<void> {
    const publicConnection = publicWebSockets.get(frame.connId);
    if (publicConnection !== undefined) {
      routeWebSocketFrameToBrowser(publicConnection, frame);
      return;
    }

    if (frame.browserOutTopic !== undefined) {
      await broker.send(frame.browserOutTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      });
    }
  }

  async function routeLocalWebSocketClose(frame: WsClose): Promise<void> {
    const publicConnection = publicWebSockets.get(frame.connId);
    if (publicConnection !== undefined) {
      routeWebSocketFrameToBrowser(publicConnection, frame);
      return;
    }

    if (frame.browserOutTopic !== undefined) {
      await broker.send(frame.browserOutTopic, frame, {
        idempotencyKey: frame.frameId,
        ttlSeconds: QUEUE_RESPONSE_TTL_SECONDS,
      });
    }
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
        client.inFlight < client.capacity
      ) {
        return client;
      }
    }

    return undefined;
  }

  function decrementPublicWebSocketCount(slug: string): void {
    const count = publicWebSocketCountsBySlug.get(slug) ?? 0;
    if (count <= 1) {
      publicWebSocketCountsBySlug.delete(slug);
      return;
    }

    publicWebSocketCountsBySlug.set(slug, count - 1);
  }
}

function createBroker(config: GatewayConfig, getOidcToken: () => string | undefined): Broker {
  if (config.brokerKind === "memory") {
    return new MemoryQueueBroker();
  }

  return new VercelQueueBroker(config.queueRegion, getOidcToken);
}

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

function isExpired(frame: Frame): boolean {
  return "deadlineAt" in frame && frame.deadlineAt !== undefined && frame.deadlineAt < Date.now();
}

function rawDataToText(
  data: RawData,
):
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly error: Error } {
  if (typeof data === "string") {
    return { _tag: "ok", value: data };
  }

  if (Buffer.isBuffer(data)) {
    return { _tag: "ok", value: data.toString("utf8") };
  }

  if (data instanceof ArrayBuffer) {
    return { _tag: "ok", value: Buffer.from(data).toString("utf8") };
  }

  if (Array.isArray(data)) {
    return { _tag: "ok", value: Buffer.concat(data).toString("utf8") };
  }

  return { _tag: "err", error: new Error("Unsupported WebSocket data type") };
}

function rawDataToBytes(data: RawData): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  return Buffer.concat(data);
}

function parseSubprotocolHeader(
  value: string | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  const raw = typeof value === "string" ? value : value?.join(",");
  if (raw === undefined) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function hasValidBearerAuth(
  value: string | ReadonlyArray<string> | undefined,
  expectedSecret: string,
): boolean {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
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

function firstHeaderValue(value: string | ReadonlyArray<string> | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) {
    return value;
  }

  return value[0];
}

function oidcTokenFromRequest(request: IncomingMessage): string | undefined {
  return firstHeaderValue(request.headers["x-vercel-oidc-token"]);
}

function observePromise(promise: Promise<unknown>, logger: Logger, operation: string): void {
  promise.catch((cause: unknown) => {
    logger.error({ operation, cause: summarizeCause(cause) }, "detached relay operation failed");
  });
}

function summarizeCause(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }

  return { type: typeof cause };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
