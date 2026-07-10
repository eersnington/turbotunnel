/** Owns one public Node HTTP request lifecycle and its direct-or-queued tunnel routing. */
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  httpResponseTopic,
  MAX_REQUEST_BODY_BYTES,
  parseTunnelRequestTarget,
  PROTOCOL_VERSION,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_REQUEST_TTL_SECONDS,
  requestTopic,
  type HttpRequest,
  type HttpResponse,
} from "@turbotunnel/contracts";
import { Clock, Effect, Option, Result } from "effect";
import { nanoid } from "nanoid";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState, type LocalClient } from "./gateway-state.js";
import {
  parseGatewayRequestHeaders,
  requestHeadersForLocalApp,
  responseHeadersForBrowser,
} from "./headers.js";
import { extractSlugFromHost, isGatewayRootHost } from "./host.js";
import { OidcToken } from "./oidc-token.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";
import { waitForHttpResponseFromQueue } from "./response-waiter.js";
import { formatGatewayStatus, gatewayStatus } from "./gateway-status.js";
import type { GatewayWebSocketWriteError } from "./websocket.js";

/** Expected dependency failures while serving one public HTTP request. */
export type PublicHttpError =
  | GatewayWebSocketWriteError
  | QueueAckError
  | QueueAuthError
  | QueueReceiveError
  | QueueSendError;

/** Serves one public HTTP request through a direct or queued tunnel route. */
export function handlePublicHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Effect.Effect<void, PublicHttpError, GatewayConfig | GatewayState | OidcToken | Queue> {
  return Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const state = yield* GatewayState;
    const oidcToken = yield* OidcToken;
    const queue = yield* Queue;
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
      yield* writeGatewayStatus(response, request, config, state);
      return;
    }

    const slugResult = extractSlugFromHost(headers.host, config.baseDomain);
    if (slugResult._tag === "err") {
      if (isGatewayRootHost(headers.host, config.baseDomain)) {
        yield* writeGatewayStatus(response, request, config, state);
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
    const localClient = yield* state.pickLocalClient(slug);
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
      yield* state.recordMetric("directHttpRequests");
      const direct = yield* forwardHttpDirect(state, localClient, frame).pipe(Effect.scoped);
      switch (direct._tag) {
        case "response":
          writeHttpResponse(response, direct.response);
          return;
        case "disconnected-before-forwarding":
          writePlainResponse(response, 502, "Local tunnel client disconnected before forwarding.");
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

    yield* state.recordMetric("queuedHttpRequests");
    yield* queue.send(requestTopic(slug), frame, {
      idempotencyKey: frame.frameId,
      ttlSeconds: QUEUE_REQUEST_TTL_SECONDS,
    });
    yield* state.recordMetric("queueSends");

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

/** Registers a scoped direct request and classifies forwarding, disconnect, and timeout outcomes. */
function forwardHttpDirect(
  state: GatewayState["Service"],
  localClient: LocalClient,
  frame: HttpRequest,
) {
  return Effect.gen(function* () {
    const awaitResult = yield* state.registerDirectRequest(localClient, frame.requestId);
    if (!(yield* localClient.socket.sendFrame(frame))) {
      return { _tag: "disconnected-before-forwarding" } as const;
    }

    const completed = yield* awaitResult.pipe(Effect.timeoutOption(PUBLIC_HTTP_TIMEOUT_MS));
    if (Option.isNone(completed)) {
      return { _tag: "timeout" } as const;
    }
    return completed.value._tag === "response"
      ? ({ _tag: "response", response: completed.value.response } as const)
      : ({ _tag: "disconnected-before-response" } as const);
  });
}

/** Projects the current state snapshot into JSON or the gateway landing-page representation. */
function writeGatewayStatus(
  response: ServerResponse,
  request: IncomingMessage,
  config: GatewayConfig["Service"],
  state: GatewayState["Service"],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stats = yield* state.snapshotStatus;
    const body = gatewayStatus(config, stats, yield* Clock.currentTimeMillis);
    if (request.headers.accept?.includes("application/json")) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(body)}\n`);
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${formatGatewayStatus(body)}\n`);
  });
}

/** Projects a tunnel HTTP response frame back onto the Node response boundary. */
function writeHttpResponse(response: ServerResponse, frame: HttpResponse): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(frame.status, responseHeadersForBrowser(frame.headers));
  response.end(Buffer.from(frame.body, "base64"));
}

/** Writes a plain-text response unless the Node response has already ended. */
export function writePlainResponse(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

type ReadLimitedBodyResult =
  | { readonly _tag: "ok"; readonly value: Buffer }
  | { readonly _tag: "err"; readonly error: ReadLimitedBodyError };

type ReadLimitedBodyError =
  | { readonly reason: "too-large"; readonly limitBytes: number }
  | { readonly reason: "read-failed"; readonly cause: unknown };

/** Reads a Node request body with interruption cleanup and the established byte limit. */
function readLimitedBody(
  request: IncomingMessage,
  maxBytes: number,
): Effect.Effect<ReadLimitedBodyResult> {
  return Effect.callback((resume) => {
    const chunks: Array<Buffer> = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
    };
    const finish = (result: ReadLimitedBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resume(Effect.succeed(result));
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
