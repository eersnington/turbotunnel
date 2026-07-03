import { Buffer } from "node:buffer";

import {
  type HeaderPair,
  type HttpRequest,
  type HttpResponse,
  MAX_RESPONSE_BODY_BYTES,
  PUBLIC_HTTP_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "@repo/turbotunnel-protocol";
import { Effect } from "effect";
import { nanoid } from "nanoid";

import type { LocalTarget } from "../config.js";
import {
  LocalHttpRequestFailed,
  LocalHttpRequestTimedOut,
  LocalHttpResponseTooLarge,
} from "../errors.js";

const RESPONSE_HEADERS_DROPPED_BY_TUNNEL = new Set(["content-encoding", "content-length"]);

/** Forward one relay HTTP request frame to the configured localhost target. */
export async function forwardHttpToLocalApp(
  frame: HttpRequest,
  target: LocalTarget,
): Promise<HttpResponse> {
  return Effect.runPromise(forwardHttpToLocalAppEffect(frame, target));
}

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
  const url = new URL(frame.path, `${target.protocol}://${target.host}:${target.port}`);
  const requestHeaders: Array<[string, string]> = [];
  for (const [name, value] of frame.headers) {
    requestHeaders.push([name, value]);
  }

  const response = yield* Effect.tryPromise({
    try: () =>
      globalThis.fetch(url, {
        method: frame.method,
        headers: requestHeaders,
        body: requestBody(frame),
        signal: AbortSignal.timeout(PUBLIC_HTTP_TIMEOUT_MS),
      }),
    catch: (cause) => requestFailureFromCause(cause, target),
  });

  const body = Buffer.from(
    yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) => requestFailureFromCause(cause, target),
    }),
  );
  if (body.byteLength > MAX_RESPONSE_BODY_BYTES) {
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
    status: response.status,
    headers: responseHeadersToPairs(response.headers),
    body: body.toString("base64"),
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

function methodAllowsBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function requestBody(frame: HttpRequest): BodyInit | undefined {
  if (!methodAllowsBody(frame.method)) {
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

function isTimeoutCause(cause: unknown): boolean {
  return (
    cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError")
  );
}

function requestFailureFromCause(
  cause: unknown,
  target: LocalTarget,
): LocalHttpRequestFailed | LocalHttpRequestTimedOut {
  if (isTimeoutCause(cause)) {
    return new LocalHttpRequestTimedOut({
      host: target.host,
      port: target.port,
      cause,
      message: `Local app at http://${target.host}:${target.port} did not respond before the tunnel timeout. Confirm the app is responsive there, or restart the tunnel with --host <host>.`,
    });
  }

  return new LocalHttpRequestFailed({
    host: target.host,
    port: target.port,
    cause,
    message: `Local app request failed at http://${target.host}:${target.port}. Confirm the app is listening there, or restart the tunnel with --host <host>.`,
  });
}
