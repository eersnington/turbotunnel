import { describe, expect, it } from "@effect/vitest";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GATEWAY_STATUS_BODY_LIMIT } from "../src/adapters/gateway-status-checker.js";
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

  it.effect("retries a deployment-propagation 404 and then accepts a running gateway", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        const response =
          attempts === 1 ? new Response("not ready", { status: 404 }) : gatewayResponse();
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const verification = Effect.gen(function* () {
        yield* (yield* GatewayVerifier).verify(deployPlan);
      }).pipe(
        Effect.provide(GatewayVerifier.live),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const fiber = yield* Effect.forkChild(verification);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(attempts).toBe(2);
    }),
  );

  it.effect("times out while decoding an incomplete response body", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, incompleteResponse())),
      );
      const verification = Effect.gen(function* () {
        yield* (yield* GatewayVerifier).verify(deployPlan);
      }).pipe(
        Effect.provide(GatewayVerifier.live),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const fiber = yield* Effect.forkChild(verification);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("90 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.reason).toBe("timeout");
    }),
  );

  for (const status of [401, 403]) {
    it.effect(`does not retry HTTP ${status}`, () =>
      Effect.gen(function* () {
        const { attempts, error } = yield* runFailingVerification(
          new Response("denied", { status }),
        );
        expect(attempts()).toBe(1);
        expect(error).toMatchObject({ reason: "bad-status", status });
      }),
    );
  }

  it.effect("does not retry a malformed successful response", () =>
    Effect.gen(function* () {
      const { attempts, error } = yield* runFailingVerification(
        new Response("not json", { status: 200 }),
      );
      expect(attempts()).toBe(1);
      expect(error.reason).toBe("body-mismatch");
    }),
  );

  it.effect("does not retry an incompatible gateway version", () =>
    Effect.gen(function* () {
      const { attempts, error } = yield* runFailingVerification(
        gatewayResponse({ version: "0.0.0-incompatible" }),
      );
      expect(attempts()).toBe(1);
      expect(error.reason).toBe("body-mismatch");
    }),
  );

  it.effect("rejects an oversized response without retrying", () =>
    Effect.gen(function* () {
      const { attempts, error } = yield* runFailingVerification(
        new Response("x".repeat(GATEWAY_STATUS_BODY_LIMIT + 1), { status: 200 }),
      );
      expect(attempts()).toBe(1);
      expect(error.reason).toBe("body-mismatch");
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

function runFailingVerification(response: Response) {
  return Effect.gen(function* () {
    let attemptCount = 0;
    const client = HttpClient.make((request) => {
      attemptCount += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const error = yield* Effect.gen(function* () {
      return yield* (yield* GatewayVerifier).verify(deployPlan);
    }).pipe(
      Effect.provide(GatewayVerifier.live),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
    );
    return { attempts: () => attemptCount, error };
  });
}

function gatewayResponse(overrides: { readonly version?: string } = {}): Response {
  return Response.json({
    status: "running",
    version: overrides.version ?? TURBOTUNNEL_VERSION,
    baseDomain: deployPlan.baseDomain,
    broker: "vercel-queue",
    queueRegion: deployPlan.queueRegion,
  });
}

function incompleteResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }),
    { status: 200 },
  );
}

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
