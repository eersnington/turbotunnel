/** Owns one public Node HTTP request lifecycle and its direct-or-queued tunnel routing. */
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  httpResponseTopic,
  MAX_REQUEST_BODY_BYTES,
  decodeTunnelRequestTarget,
  PROTOCOL_VERSION,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_REQUEST_TTL_SECONDS,
  requestTopic,
  type HttpRequest,
  type HttpResponse,
} from "@turbotunnel/contracts";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { nanoid } from "nanoid";

import { GatewayConfig } from "./gateway-config.js";
import { admitPublicAccess, makeAccessCookie, verifyScryptPassword } from "./access.js";
import { hasValidBearerAuth } from "./auth.js";
import { GatewayState, type LocalClient } from "./gateway-state.js";
import {
  parseGatewayRequestHeaders,
  requestHeadersForLocalApp,
  responseHeadersForBrowser,
} from "./headers.js";
import { isGatewayRootHost, normalizeHost } from "./host.js";
import {
  localAppUnavailablePage,
  passwordLoginPage,
  routeConflictPage,
  routeNotReadyPage,
  tunnelNotFoundPage,
} from "./gateway-pages.js";
import { OidcToken } from "./oidc-token.js";
import { listTunnels, type PresenceReplayLimitError } from "./presence.js";
import { PublicRouteRegistry, type PublicRoute } from "./public-route-registry.js";
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
  | PresenceReplayLimitError
  | QueueAckError
  | QueueAuthError
  | QueueReceiveError
  | QueueSendError;

/** Serves one public HTTP request through a direct or queued tunnel route. */
export const handlePublicHttp = Effect.fn("handlePublicHttp")(function* (
  request: IncomingMessage,
  response: ServerResponse,
): Effect.fn.Return<
  void,
  PublicHttpError,
  GatewayConfig | GatewayState | OidcToken | PublicRouteRegistry | Queue
> {
  const config = yield* GatewayConfig;
  const state = yield* GatewayState;
  const oidcToken = yield* OidcToken;
  const queue = yield* Queue;
  const routes = yield* PublicRouteRegistry;
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
  const pathname = URL.parse(request.url ?? "/", "http://gateway.invalid")?.pathname;
  if (request.method === "GET" && pathname === "/_turbotunnel/tunnels") {
    if (!hasValidBearerAuth(headers.authorization, Redacted.value(config.relaySecret))) {
      writePlainResponse(response, 401, "A valid relay bearer token is required.");
      return;
    }
    const body = yield* listTunnels();
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(body)}\n`);
    return;
  }
  if (request.url === "/_turbotunnel/status") {
    yield* writeGatewayStatus(response, request, config, state);
    return;
  }
  if (isGatewayRootHost(headers.host, config.baseDomain)) {
    yield* writeGatewayStatus(response, request, config, state);
    return;
  }

  const normalizedHost = normalizeHost(headers.host);
  if (normalizedHost === undefined) {
    writePlainResponse(response, 404, "Tunnel host was not recognized for this relay domain.");
    return;
  }

  const routeLookup = yield* routes.lookup(normalizedHost);
  if (routeLookup._tag !== "Found") {
    switch (routeLookup._tag) {
      case "Missing":
        writeGatewayHtmlPage(response, 404, tunnelNotFoundPage);
        break;
      case "NotReady":
        writeGatewayHtmlPage(response, 503, routeNotReadyPage);
        break;
      case "Conflicting":
        writeGatewayHtmlPage(response, 503, routeConflictPage);
        break;
    }
    return;
  }
  const route = routeLookup.route;
  if (pathname === "/_turbotunnel/login") {
    yield* handlePasswordLogin(request, response, route, config);
    return;
  }
  if (!admitPublicAccess(route.accessPolicy, normalizedHost, headers, config)) {
    if (route.accessPolicy.type === "password") {
      response.writeHead(303, { location: "/_turbotunnel/login" });
      response.end();
    } else {
      writePlainResponse(response, 403, "This client IP is not allowed to access the tunnel.");
    }
    return;
  }

  const body = yield* readLimitedBody(request, MAX_REQUEST_BODY_BYTES).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      RequestBodyTooLargeError: () => {
        writePlainResponse(
          response,
          413,
          "Request body is larger than the tunnel limit. The local app was not contacted.",
        );
        return Effect.succeed(Option.none<Buffer>());
      },
      RequestBodyReadError: () => {
        writePlainResponse(
          response,
          400,
          "Request body could not be read. The local app was not contacted.",
        );
        return Effect.succeed(Option.none<Buffer>());
      },
    }),
  );
  if (Option.isNone(body)) {
    return;
  }

  const requestTarget = yield* decodeTunnelRequestTarget(request.url).pipe(
    Effect.map(Option.some),
    Effect.catchTag("TunnelRequestTargetError", (error) => {
      writePlainResponse(response, 400, error.message);
      return Effect.succeed(Option.none());
    }),
  );
  if (Option.isNone(requestTarget)) {
    return;
  }

  const slug = route.slug;
  const requestId = `req_${nanoid(12)}`;
  const responseTopicName = httpResponseTopic(requestId);
  const localClient = yield* state.pickLocalClient(slug, route.identity);
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
    routeIdentity: route.identity,
    deadlineAt: now + PUBLIC_HTTP_TIMEOUT_MS,
    method: request.method ?? "GET",
    path: requestTarget.value.path,
    headers: [
      ...requestHeadersForLocalApp({
        rawHeaders: request.rawHeaders,
        localHost,
        forwardedHost: headers.host ?? "",
        forwardedProto: headers.forwardedProto,
        requestId,
      }),
    ],
    body: body.value.toString("base64"),
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

function handlePasswordLogin(
  request: IncomingMessage,
  response: ServerResponse,
  route: PublicRoute,
  config: GatewayConfig["Service"],
): Effect.Effect<void> {
  if (route.accessPolicy.type !== "password") {
    writePlainResponse(response, 404, "This tunnel does not use password access.");
    return Effect.void;
  }
  const passwordHash = route.accessPolicy.hash;
  if (request.method === "GET") {
    writePasswordLoginPage(response, 200);
    return Effect.void;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "GET, POST" });
    response.end();
    return Effect.void;
  }
  return Effect.gen(function* () {
    const body = yield* readLimitedBody(request, 16 * 1024).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        RequestBodyTooLargeError: () => {
          writePlainResponse(
            response,
            413,
            "Request body is larger than the login limit. Password was not checked.",
          );
          return Effect.succeed(Option.none<Buffer>());
        },
        RequestBodyReadError: () => {
          writePlainResponse(
            response,
            400,
            "Request body could not be read. Password was not checked.",
          );
          return Effect.succeed(Option.none<Buffer>());
        },
      }),
    );
    if (Option.isNone(body)) return;
    const password = new URLSearchParams(body.value.toString("utf8")).get("password");
    if (password === null || !(yield* verifyScryptPassword(password, passwordHash))) {
      writePasswordLoginPage(response, 401, "Password was not accepted.");
      return;
    }
    response.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": makeAccessCookie(
        route.identity.publicHost,
        passwordHash,
        Redacted.value(config.relaySecret),
      ),
    });
    response.end();
  });
}

/** Registers a scoped direct request and classifies forwarding, disconnect, and timeout outcomes. */
function forwardHttpDirect(
  state: GatewayState["Service"],
  localClient: LocalClient,
  frame: HttpRequest,
) {
  return Effect.gen(function* () {
    const request = yield* state.registerDirectRequest(localClient, frame.requestId);
    if (!(yield* localClient.socket.sendFrame(frame))) {
      return { _tag: "disconnected-before-forwarding" } as const;
    }

    const completed = yield* request.await.pipe(Effect.timeoutOption(PUBLIC_HTTP_TIMEOUT_MS));
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
  if (frame.tunnelError === "local-app-unavailable") {
    writeLocalAppUnavailable(response);
    return;
  }
  response.writeHead(frame.status, responseHeadersForBrowser(frame.headers));
  response.end(Buffer.from(frame.body, "base64"));
}

function writeLocalAppUnavailable(response: ServerResponse): void {
  writeGatewayHtmlPage(response, 502, localAppUnavailablePage);
}

function writePasswordLoginPage(response: ServerResponse, status: 200 | 401, error?: string): void {
  writeGatewayHtmlPage(
    response,
    status,
    passwordLoginPage(error === undefined ? undefined : { error }),
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function writeGatewayHtmlPage(
  response: ServerResponse,
  status: number,
  html: string,
  contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
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

export class RequestBodyTooLargeError extends Schema.TaggedErrorClass<RequestBodyTooLargeError>()(
  "RequestBodyTooLargeError",
  {
    limitBytes: Schema.Number,
    message: Schema.String,
  },
) {}

export class RequestBodyReadError extends Schema.TaggedErrorClass<RequestBodyReadError>()(
  "RequestBodyReadError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Reads a Node request body with interruption cleanup and the established byte limit. */
export function readLimitedBody(
  request: IncomingMessage,
  maxBytes: number,
): Effect.Effect<Buffer, RequestBodyTooLargeError | RequestBodyReadError> {
  return Effect.callback((resume) => {
    const chunks: Array<Buffer> = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
    };
    const finish = (
      result: Effect.Effect<Buffer, RequestBodyTooLargeError | RequestBodyReadError>,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resume(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        request.pause();
        finish(
          Effect.fail(
            new RequestBodyTooLargeError({
              limitBytes: maxBytes,
              message: `Request body exceeded the ${maxBytes}-byte tunnel limit; the local app was not contacted.`,
            }),
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => finish(Effect.succeed(Buffer.concat(chunks, totalBytes)));
    const onError = (cause: unknown): void =>
      finish(
        Effect.fail(
          new RequestBodyReadError({
            cause,
            message:
              "The gateway could not read the request body; the local app was not contacted.",
          }),
        ),
      );
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    return Effect.sync(cleanup);
  });
}
