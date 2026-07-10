import { describe, expect, test } from "vitest";

import {
  parseGatewayRequestHeaders,
  publicWebSocketHeaders,
  requestHeadersForLocalApp,
  responseHeadersForBrowser,
} from "../src/headers.js";

describe("parseGatewayRequestHeaders", () => {
  test("rejects duplicate Host", () => {
    expect(parseGatewayRequestHeaders(["Host", "a.test", "host", "b.test"])).toEqual({
      _tag: "err",
      header: "Host",
    });
  });

  test("rejects duplicate Authorization", () => {
    expect(
      parseGatewayRequestHeaders([
        "Authorization",
        "Bearer first",
        "authorization",
        "Bearer second",
      ]),
    ).toEqual({ _tag: "err", header: "Authorization" });
  });

  test("rejects duplicate X-Vercel-OIDC-Token", () => {
    expect(
      parseGatewayRequestHeaders(["X-Vercel-OIDC-Token", "first", "x-vercel-oidc-token", "second"]),
    ).toEqual({ _tag: "err", header: "X-Vercel-OIDC-Token" });
  });

  test("defaults forwardedProto to https", () => {
    expect(parseGatewayRequestHeaders([])).toEqual({
      _tag: "ok",
      value: {
        host: undefined,
        authorization: undefined,
        oidcToken: undefined,
        forwardedProto: "https",
        secWebSocketProtocols: [],
      },
    });
  });

  test("picks the first comma-separated x-forwarded-proto value", () => {
    const result = parseGatewayRequestHeaders(["X-Forwarded-Proto", " http , https"]);

    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.forwardedProto).toBe("http");
    }
  });

  test("splits and trims sec-websocket-protocol", () => {
    const result = parseGatewayRequestHeaders([
      "Sec-WebSocket-Protocol",
      "chat, superchat , ,",
      "sec-websocket-protocol",
      "binary",
    ]);

    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.secWebSocketProtocols).toEqual(["chat", "superchat", "binary"]);
    }
  });
});

describe("requestHeadersForLocalApp", () => {
  test("removes hop-by-hop headers", () => {
    expect(
      requestHeadersForLocalApp({
        rawHeaders: [
          "Connection",
          "upgrade",
          "Upgrade",
          "websocket",
          "Keep-Alive",
          "timeout=5",
          "X-Custom",
          "preserved",
        ],
        localHost: "127.0.0.1:3000",
        forwardedHost: "demo.example.com",
        forwardedProto: "https",
        requestId: "req_1",
      }),
    ).toEqual([
      ["x-custom", "preserved"],
      ["host", "127.0.0.1:3000"],
      ["x-forwarded-host", "demo.example.com"],
      ["x-forwarded-proto", "https"],
      ["x-turbotunnel-request-id", "req_1"],
    ]);
  });

  test("overrides gateway-owned request headers", () => {
    expect(
      requestHeadersForLocalApp({
        rawHeaders: [
          "Host",
          "old-host",
          "X-Forwarded-Host",
          "old-forwarded-host",
          "X-Forwarded-Proto",
          "http",
          "X-Turbotunnel-Request-Id",
          "old-request-id",
        ],
        localHost: "127.0.0.1:4000",
        forwardedHost: "demo.tunnel.example.com",
        forwardedProto: "https",
        requestId: "req_new",
      }),
    ).toEqual([
      ["host", "127.0.0.1:4000"],
      ["x-forwarded-host", "demo.tunnel.example.com"],
      ["x-forwarded-proto", "https"],
      ["x-turbotunnel-request-id", "req_new"],
    ]);
  });
});

describe("publicWebSocketHeaders", () => {
  test("removes hop-by-hop headers and host", () => {
    expect(
      publicWebSocketHeaders([
        "Host",
        "demo.example.com",
        "Connection",
        "upgrade",
        "Upgrade",
        "websocket",
        "Sec-WebSocket-Protocol",
        "chat",
        "X-Custom",
        "preserved",
      ]),
    ).toEqual([
      ["sec-websocket-protocol", "chat"],
      ["x-custom", "preserved"],
    ]);
  });
});

describe("responseHeadersForBrowser", () => {
  test("groups duplicate response headers", () => {
    expect(
      responseHeadersForBrowser([
        ["Set-Cookie", "a=1"],
        ["set-cookie", "b=2"],
        ["Content-Type", "text/plain"],
      ]),
    ).toEqual({
      "set-cookie": ["a=1", "b=2"],
      "content-type": "text/plain",
    });
  });

  test("removes hop-by-hop headers", () => {
    expect(
      responseHeadersForBrowser([
        ["Connection", "close"],
        ["Transfer-Encoding", "chunked"],
        ["X-Custom", "preserved"],
      ]),
    ).toEqual({ "x-custom": "preserved" });
  });
});
