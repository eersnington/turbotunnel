import {
  listedTunnelSchema,
  tunnelListResponseSchema,
  tunnelPresenceEventSchema,
} from "../src/presence.js";
import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

describe("presence contracts", () => {
  it("decodes the versioned presence event and bounded list response", () => {
    const target = { protocol: "http", host: "127.0.0.1", port: 3000 } as const;
    const event = Schema.decodeUnknownResult(tunnelPresenceEventSchema)({
      version: 1,
      type: "upsert",
      slug: "demo",
      sessionId: "session_1",
      localClientId: "client_1",
      generation: 1,
      sequence: 1,
      target,
      connectedAt: 1_000,
    });
    const tunnel = Schema.decodeUnknownResult(listedTunnelSchema)({
      slug: "demo",
      sessionId: "session_1",
      target,
      connectedAt: 1_000,
      relayCount: 2,
    });
    const response = Schema.decodeUnknownResult(tunnelListResponseSchema)({
      version: 1,
      consistency: "bounded",
      generatedAt: 2_000,
      tunnels: Result.isSuccess(tunnel) ? [tunnel.success] : [],
    });

    expect(Result.isSuccess(event)).toBe(true);
    expect(Result.isSuccess(tunnel)).toBe(true);
    expect(Result.isSuccess(response)).toBe(true);
  });

  it("rejects unsupported response versions and invalid timestamps", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(tunnelListResponseSchema)({
          version: 2,
          consistency: "bounded",
          generatedAt: -1,
          tunnels: [],
        }),
      ),
    ).toBe(true);
  });
});
