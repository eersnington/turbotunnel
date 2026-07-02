import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import type { HeaderPair } from "@repo/turbotunnel-protocol";

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

const REQUEST_HEADERS_OVERRIDDEN_BY_RELAY = new Set([
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-turbotunnel-request-id",
]);

/** Project incoming request headers into the local app request. */
export function requestHeadersForLocalApp(input: {
  readonly headers: IncomingHttpHeaders;
  readonly localHost: string;
  readonly forwardedHost: string;
  readonly forwardedProto: string;
  readonly requestId: string;
}): ReadonlyArray<HeaderPair> {
  const headers: Array<HeaderPair> = [];

  for (const [rawName, rawValue] of Object.entries(input.headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || REQUEST_HEADERS_OVERRIDDEN_BY_RELAY.has(name)) {
      continue;
    }

    appendHeaderValues(headers, name, rawValue);
  }

  headers.push(["host", input.localHost]);
  headers.push(["x-forwarded-host", input.forwardedHost]);
  headers.push(["x-forwarded-proto", input.forwardedProto]);
  headers.push(["x-turbotunnel-request-id", input.requestId]);

  return headers;
}

/** Project incoming upgrade headers into a local WebSocket open frame. */
export function publicWebSocketHeaders(headers: IncomingHttpHeaders): ReadonlyArray<HeaderPair> {
  const projected: Array<HeaderPair> = [];

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === "host") {
      continue;
    }

    appendHeaderValues(projected, name, rawValue);
  }

  return projected;
}

/** Convert protocol response headers into Node response headers. */
export function responseHeadersForBrowser(headers: ReadonlyArray<HeaderPair>): OutgoingHttpHeaders {
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

/** Read the effective forwarded protocol from Vercel or local dev headers. */
export function forwardedProto(headers: IncomingHttpHeaders): string {
  const raw = headers["x-forwarded-proto"];
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",")[0]?.trim() || "https";
  }

  return "https";
}

function appendHeaderValues(
  target: Array<HeaderPair>,
  name: string,
  value: string | ReadonlyArray<string> | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value === "string") {
    target.push([name, value]);
    return;
  }

  for (const entry of value) {
    target.push([name, entry]);
  }
}
