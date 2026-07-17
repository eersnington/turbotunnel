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
    const eventInput = {
      version: 1,
      type: "upsert",
      slug: "demo",
      publicHost: "demo.tunnel.test",
      accessPolicy: { type: "public" },
      sessionId: "session_1",
      localClientId: "client_1",
      generation: 1,
      sequence: 1,
      target,
      connectedAt: 1_000,
    } as const;
    const tunnelInput = {
      slug: "demo",
      sessionId: "session_1",
      target,
      connectedAt: 1_000,
      relayCount: 2,
    } as const;
    const responseInput = {
      version: 1,
      consistency: "bounded",
      generatedAt: 2_000,
      tunnels: [Schema.decodeUnknownSync(listedTunnelSchema)(tunnelInput)],
    } as const;

    const event = Schema.decodeUnknownResult(tunnelPresenceEventSchema)(eventInput);
    const response = Schema.decodeUnknownResult(tunnelListResponseSchema)(responseInput);

    expect(event).toEqual(Result.succeed(eventInput));
    expect(response).toEqual(Result.succeed(responseInput));
  });

  it("rejects unsupported response versions", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(tunnelListResponseSchema)({
          version: 2,
          consistency: "bounded",
          generatedAt: 1,
          tunnels: [],
        }),
      ),
    ).toBe(true);
  });

  it("rejects negative response timestamps", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(tunnelListResponseSchema)({
          version: 1,
          consistency: "bounded",
          generatedAt: -1,
          tunnels: [],
        }),
      ),
    ).toBe(true);
  });
});
