import { Buffer } from "node:buffer";

import {
  type HeaderPair,
  type HttpRequest,
  type HttpResponse,
  localUrlFromTunnelRequestTarget,
  MAX_RESPONSE_BODY_BYTES,
  parseTunnelRequestTarget,
  PUBLIC_HTTP_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "@turbotunnel/protocol";
import { Effect, Result } from "effect";
import { nanoid } from "nanoid";

import type { LocalTarget } from "../config.js";
import {
  LocalHttpRequestFailed,
  LocalHttpRequestTimedOut,
  LocalHttpResponseTooLarge,
} from "../errors.js";

const RESPONSE_HEADERS_DROPPED_BY_TUNNEL = new Set(["content-encoding", "content-length"]);

export const forwardHttpToLocalAppEffect = Effect.fn("forwardHttpToLocalAppEffect")(function* (
  frame: HttpRequest,
  target: LocalTarget,
): Effect.fn.Return<HttpResponse, never, never> {
  return yield* fetchLocalHttp(frame, target).pipe(
    Effect.catch((error) =>
      Effect.succeed(textResponse(frame.requestId, frame.responseTopic, 502, error.message)),
    ),
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
  const requestTarget = parseTunnelRequestTarget(frame.path);
  if (Result.isFailure(requestTarget)) {
    return yield* new LocalHttpRequestFailed({
      host: target.host,
      port: target.port,
      cause: requestTarget.failure,
      message: "Tunnel request path was invalid; the local app was not contacted.",
    });
  }

  const url = localUrlFromTunnelRequestTarget({
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    requestTarget: requestTarget.success,
  });
  const requestHeaders: Array<[string, string]> = [];
  for (const [name, value] of frame.headers) {
    requestHeaders.push([name, value]);
  }

  const forwarded = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await globalThis.fetch(url, {
        method: frame.method,
        headers: requestHeaders,
        body: requestBody(frame),
        signal,
      });
      const body = Buffer.from(await response.arrayBuffer());

      return { response, body };
    },
    catch: (cause) => requestFailureFromCause(cause, target),
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

  if (forwarded.body.byteLength > MAX_RESPONSE_BODY_BYTES) {
    return yield* new LocalHttpResponseTooLarge({
      limitBytes: MAX_RESPONSE_BODY_BYTES,
      message: "Local app response exceeded the tunnel response size limit.",
    });
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "http.response",
    frameId: `frm_${nanoid(12)}`,
    requestId: frame.requestId,
    responseTopic: frame.responseTopic,
    status: forwarded.response.status,
    headers: responseHeadersToPairs(forwarded.response.headers),
    body: forwarded.body.toString("base64"),
  };
});

function responseHeadersToPairs(headers: globalThis.Headers): Array<HeaderPair> {
  const pairs: Array<HeaderPair> = [];
  headers.forEach((value, name) => {
    if (RESPONSE_HEADERS_DROPPED_BY_TUNNEL.has(name.toLowerCase())) {
      return;
    }

    pairs.push([name, value]);
  });

  return pairs;
}

function requestBody(frame: HttpRequest): BodyInit | undefined {
  const method = frame.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  return Uint8Array.from(Buffer.from(frame.body, "base64"));
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
    body: Buffer.from(`${message}\n`, "utf8").toString("base64"),
  };
}

function requestFailureFromCause(cause: unknown, target: LocalTarget): LocalHttpRequestFailed {
  return new LocalHttpRequestFailed({
    host: target.host,
    port: target.port,
    cause,
    message: `Local app request failed at http://${target.host}:${target.port}. Confirm the app is listening there, or restart the tunnel with --host <host>.`,
  });
}
