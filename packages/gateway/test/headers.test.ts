import { describe, expect, test } from "vitest";

import { parseGatewayRequestHeaders, publicWebSocketHeaders } from "../src/headers.js";

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
