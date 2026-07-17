import { Result } from "effect";
import { describe, expect, test } from "vitest";

import {
  parseProtocolFrameJson,
  parseProtocolFramePayload,
  PROTOCOL_VERSION,
  ProtocolFrameParseError,
} from "../src/index.js";

describe("protocol frame parsing", () => {
  test("parses valid frame JSON into a typed frame", () => {
    const parsed = parseProtocolFrameJson(JSON.stringify(validHttpRequestFrame()));

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.type).toBe("http.request");
      if (parsed.success.type === "http.request") {
        expect(parsed.success.path).toBe("/hello?name=tt");
        expect(parsed.success.headers).toEqual([["accept", "text/plain"]]);
      }
    }
  });

  test("classifies malformed JSON separately from invalid frame payloads", () => {
    const parsed = parseProtocolFrameJson("{ nope");

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure).toBeInstanceOf(ProtocolFrameParseError);
      expect(parsed.failure.reason).toBe("invalid-json");
    }
  });

  test("rejects unsupported frame shapes", () => {
    const parsed = parseProtocolFrameJson(JSON.stringify({ type: "unknown.frame" }));

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure).toBeInstanceOf(ProtocolFrameParseError);
      expect(parsed.failure.reason).toBe("invalid-frame");
    }
  });

  test("rejects excess frame properties", () => {
    const parsed = parseProtocolFramePayload({ ...validHttpRequestFrame(), extra: true });

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure.reason).toBe("invalid-frame");
    }
  });
});

function validHttpRequestFrame() {
  return {
    type: "http.request",
    protocolVersion: PROTOCOL_VERSION,
    frameId: "frm_1",
    requestId: "req_1",
    responseTopic: "tt_res_req_1",
    routeIdentity: {
      publicHost: "demo-turbotunnel.vercel.app",
      policyFingerprint: "policy-v1:test",
      sessionId: "session_1",
    },
    method: "GET",
    path: "/hello?name=tt",
    headers: [["accept", "text/plain"]],
    body: "",
  };
}
