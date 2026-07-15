import { describe, expect, it } from "@effect/vitest";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GatewayVerifier } from "../src/adapters/gateway-verifier.js";
import type { DeployPlan } from "../src/domain/deploy-plan.js";

describe("GatewayVerifier.live", () => {
  it.effect("retries four times with exponential backoff and preserves the final error", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("gateway unavailable", { status: 503 })),
        );
      });
      const verification = Effect.gen(function* () {
        const verifier = yield* GatewayVerifier;
        return yield* verifier.verify(deployPlan);
      }).pipe(
        Effect.provide(GatewayVerifier.live),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const fiber = yield* Effect.forkChild(verification);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(attempts).toBe(5);
      expect(error.reason).toBe("bad-status");
      expect(error.status).toBe(503);
    }),
  );

  it.effect("accepts a matching status response without retrying", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                status: "running",
                version: TURBOTUNNEL_VERSION,
                baseDomain: deployPlan.baseDomain,
                broker: "vercel-queue",
                queueRegion: deployPlan.queueRegion,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        );
      });

      yield* Effect.gen(function* () {
        const verifier = yield* GatewayVerifier;
        yield* verifier.verify(deployPlan);
      }).pipe(
        Effect.provide(GatewayVerifier.live),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(attempts).toBe(1);
    }),
  );

  it.effect("does not retry deterministic status URL failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make(() => {
        attempts += 1;
        return Effect.die("the HTTP client must not run for an invalid status URL");
      });
      const error = yield* Effect.gen(function* () {
        const verifier = yield* GatewayVerifier;
        return yield* verifier.verify({ ...deployPlan, publicHost: "[" });
      }).pipe(
        Effect.provide(GatewayVerifier.live),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(attempts).toBe(0);
      expect(error.reason).toBe("unknown");
    }),
  );
});

const deployPlan: DeployPlan = {
  slug: "demo",
  project: "demo-turbotunnel",
  baseDomain: "{slug}-turbotunnel.vercel.app",
  publicHost: "demo-turbotunnel.vercel.app",
  queueRegion: "iad1",
  relaySecret: Redacted.make("test-secret", { label: "relay-secret" }),
  deployDir: "/tmp/turbotunnel/relay",
  configPath: "/tmp/turbotunnel/config.json",
  reusedSavedTarget: false,
};
