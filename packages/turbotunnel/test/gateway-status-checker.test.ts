import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  GATEWAY_STATUS_BODY_LIMIT,
  GatewayStatusChecker,
} from "../src/adapters/gateway-status-checker.js";

describe("GatewayStatusChecker.live", () => {
  it.effect("keeps transport failures distinct from HTTP rejection", () =>
    Effect.gen(function* () {
      const transport = yield* runCheck(
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: "offline" }),
            }),
          ),
        ),
      );
      const rejected = yield* runCheck(responseClient(new Response("denied", { status: 401 })));

      expect(transport).toEqual({
        url: statusUrl,
        status: "unreachable",
        reason: "transport-failure",
      });
      expect(rejected).toEqual({ url: statusUrl, status: "rejected", statusCode: 401 });
    }),
  );

  it.effect("classifies malformed and oversized successful responses", () =>
    Effect.gen(function* () {
      const malformed = yield* runCheck(responseClient(new Response("not json", { status: 200 })));
      const oversized = yield* runCheck(
        responseClient(new Response("x".repeat(GATEWAY_STATUS_BODY_LIMIT + 1), { status: 200 })),
      );

      expect(malformed).toEqual({
        url: statusUrl,
        status: "invalid-response",
        reason: "malformed",
      });
      expect(oversized).toEqual({
        url: statusUrl,
        status: "invalid-response",
        reason: "too-large",
      });
    }),
  );

  it.effect("interrupts a many-chunk body as soon as its byte total exceeds the limit", () =>
    Effect.gen(function* () {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1_024));
        },
        cancel() {
          cancelled = true;
        },
      });

      const result = yield* runCheck(responseClient(new Response(body, { status: 200 })));

      expect(result).toMatchObject({ status: "invalid-response", reason: "too-large" });
      expect(pulls).toBeLessThanOrEqual(10);
      expect(cancelled).toBe(true);
    }),
  );

  it.effect("classifies timeout separately", () =>
    Effect.gen(function* () {
      const fiber = yield* runCheck(HttpClient.make(() => Effect.never)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({
        url: statusUrl,
        status: "unreachable",
        reason: "timeout",
      });
    }),
  );
});

const statusUrl = "https://gateway.example/_turbotunnel/status";

function responseClient(response: Response): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response)),
  );
}

function runCheck(client: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    return yield* (yield* GatewayStatusChecker).check(statusUrl, "secret");
  }).pipe(
    Effect.provide(GatewayStatusChecker.live),
    Effect.provideService(HttpClient.HttpClient, client),
  );
}
