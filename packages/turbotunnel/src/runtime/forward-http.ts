import {
  type HttpRequest,
  type HttpResponse,
  decodeTunnelRequestTarget,
  makeLocalUrlFromTunnelRequestTarget,
  MAX_RESPONSE_BODY_BYTES,
  PUBLIC_HTTP_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "@turbotunnel/contracts";
import { Effect } from "effect";
import { nanoid } from "nanoid";

import { decodeBase64, encodeBase64, encodeUtf8 } from "../adapters/bytes.js";
import { requestLocalHttp } from "../adapters/local-http.js";
import type { LocalTarget } from "../domain/tunnel-config.js";
import {
  LocalHttpRequestFailed,
  LocalHttpRequestTimedOut,
  LocalHttpResponseTooLarge,
} from "../errors.js";

const RESPONSE_HEADERS_DROPPED_BY_TUNNEL = new Set(["content-encoding", "content-length"]);

export const forwardHttpToLocalApp = Effect.fn("forwardHttpToLocalApp")(function* (
  frame: HttpRequest,
  target: LocalTarget,
): Effect.fn.Return<HttpResponse, never, never> {
  return yield* fetchLocalHttp(frame, target).pipe(
    Effect.catchTags({
      LocalHttpRequestFailed: (error) =>
        Effect.succeed(
          textResponse(frame.requestId, frame.responseTopic, 502, publicHttpError(error)),
        ),
      LocalHttpRequestTimedOut: (error) =>
        Effect.succeed(
          textResponse(frame.requestId, frame.responseTopic, 502, publicHttpError(error)),
        ),
      LocalHttpResponseTooLarge: (error) =>
        Effect.succeed(
          textResponse(frame.requestId, frame.responseTopic, 502, publicHttpError(error)),
        ),
    }),
  );
});

const fetchLocalHttp = Effect.fn("fetchLocalHttp")(function* (
  frame: HttpRequest,
  target: LocalTarget,
): Effect.fn.Return<
  HttpResponse,
  LocalHttpRequestFailed | LocalHttpRequestTimedOut | LocalHttpResponseTooLarge,
  never
> {
  const requestTarget = yield* decodeTunnelRequestTarget(frame.path).pipe(
    Effect.mapError(
      (cause) =>
        new LocalHttpRequestFailed({
          host: target.host,
          port: target.port,
          cause,
          message: "Tunnel request path was invalid; the local app was not contacted.",
        }),
    ),
  );
  const url = yield* makeLocalUrlFromTunnelRequestTarget({
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    requestTarget,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalHttpRequestFailed({
          host: target.host,
          port: target.port,
          cause,
          message: cause.message,
        }),
    ),
  );
  const forwarded = yield* requestLocalHttp({
    url,
    method: frame.method,
    headers: frame.headers,
    body: requestBody(frame),
    maxResponseBytes: MAX_RESPONSE_BODY_BYTES,
    host: target.host,
    port: target.port,
  }).pipe(
    Effect.timeoutOrElse({
      duration: PUBLIC_HTTP_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new LocalHttpRequestTimedOut({
            host: target.host,
            port: target.port,
            cause: { timeoutMs: PUBLIC_HTTP_TIMEOUT_MS },
            message: `Local app at http://${target.host}:${target.port} did not respond before the tunnel timeout. Confirm the app is responsive there, or restart the tunnel with --host <host>.`,
          }),
        ),
    }),
  );

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "http.response",
    frameId: `frm_${nanoid(12)}`,
    requestId: frame.requestId,
    responseTopic: frame.responseTopic,
    status: forwarded.status,
    headers: forwarded.headers.filter(
      ([name]) => !RESPONSE_HEADERS_DROPPED_BY_TUNNEL.has(name.toLowerCase()),
    ),
    body: encodeBase64(forwarded.body),
  };
});

function requestBody(frame: HttpRequest): Uint8Array | undefined {
  const method = frame.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  return decodeBase64(frame.body);
}

function textResponse(
  requestId: string,
  responseTopic: string,
  status: number,
  message: string,
): HttpResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "http.response",
    frameId: `frm_${nanoid(12)}`,
    requestId,
    responseTopic,
    status,
    headers: [["content-type", "text/plain; charset=utf-8"]],
    body: encodeBase64(encodeUtf8(`${message}\n`)),
  };
}

function publicHttpError(
  error: LocalHttpRequestFailed | LocalHttpRequestTimedOut | LocalHttpResponseTooLarge,
): string {
  switch (error._tag) {
    case "LocalHttpResponseTooLarge":
      return "Local app response exceeded the tunnel response size limit.";
    case "LocalHttpRequestFailed":
    case "LocalHttpRequestTimedOut":
      return "Tunnel could not reach the local app. Check the local Turbotunnel process.";
  }
}
