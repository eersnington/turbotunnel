import type { OutgoingHttpHeaders } from "node:http";

import type { HeaderPair } from "@turbotunnel/contracts";

/** Parsed request headers used by the gateway runtime. */
export type GatewayRequestHeaders = {
  readonly host: string | undefined;
  readonly authorization: string | undefined;
  readonly oidcToken: string | undefined;
  readonly forwardedProto: string;
  readonly secWebSocketProtocols: ReadonlyArray<string>;
};

/** Result of parsing gateway request headers, including rejected singleton duplicates. */
export type GatewayRequestHeadersResult =
  | { readonly _tag: "ok"; readonly value: GatewayRequestHeaders }
  | { readonly _tag: "err"; readonly header: string };

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

/** Parse raw Node request headers without collapsing duplicate singleton headers. */
export function parseGatewayRequestHeaders(
  rawHeaders: ReadonlyArray<string>,
): GatewayRequestHeadersResult {
  let host: string | undefined;
  let authorization: string | undefined;
  let oidcToken: string | undefined;
  const forwardedProtoValues: Array<string> = [];
  const secWebSocketProtocols: Array<string> = [];

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const value = rawHeaders[index + 1];
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

/** Project browser request headers for the local app and apply gateway-owned values. */
export function requestHeadersForLocalApp(input: {
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

/** Project public WebSocket upgrade headers into a tunnel protocol frame. */
export function publicWebSocketHeaders(
  rawHeaders: ReadonlyArray<string>,
): ReadonlyArray<HeaderPair> {
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

/** Project tunnel response header pairs into Node response headers. */
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
