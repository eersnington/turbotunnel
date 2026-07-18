import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GatewayControlClient } from "../src/adapters/gateway-control-client.js";
import { LocalConfigStore } from "../src/adapters/local-config-store.js";

describe("GatewayControlClient.live", () => {
  it.effect("reads the saved gateway and sends an authenticated tunnel-list request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configPath = yield* writeTemporaryConfig({
          slug: "demo",
          relayDomain: "{slug}.example.com",
          relaySecret: "top_secret",
        });
        let requestedUrl: string | undefined;
        let authorization: string | undefined;
        const httpClient = HttpClient.make((request) => {
          requestedUrl = request.url;
          authorization = request.headers.authorization;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                version: 1,
                consistency: "bounded",
                generatedAt: 61_000,
                tunnels: [
                  {
                    slug: "shop",
                    sessionId: "session_1",
                    target: { protocol: "http", host: "localhost", port: 5173 },
                    connectedAt: 1_000,
                    relayCount: 2,
                  },
                ],
              }),
            ),
          );
        });

        const response = yield* Effect.gen(function* () {
          return yield* (yield* GatewayControlClient).listTunnels;
        }).pipe(
          Effect.provide(GatewayControlClient.live),
          Effect.provide(LocalConfigStore.layer(configPath)),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provide(NodeServices.layer),
        );

        expect(requestedUrl).toBe("https://demo.example.com/_turbotunnel/tunnels");
        expect(authorization).toBe("Bearer top_secret");
        expect(response.tunnels[0]?.slug).toBe("shop");
      }),
    ),
  );

  it.effect("rejects unauthorized responses without exposing the relay secret", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configPath = yield* writeTemporaryConfig({
          relayUrl: "http://127.0.0.1:3002",
          relaySecret: "must_not_leak",
        });
        const error = yield* runClient(
          configPath,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("denied", { status: 401 })),
            ),
          ),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({ reason: "unauthorized", status: 401 });
        expect(JSON.stringify(error)).not.toContain("must_not_leak");
      }),
    ),
  );

  it.effect("strictly rejects excess tunnel-list response fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configPath = yield* writeTemporaryConfig({
          relayUrl: "http://127.0.0.1:3002",
          relaySecret: "test_secret",
        });
        const error = yield* runClient(
          configPath,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  version: 1,
                  consistency: "bounded",
                  generatedAt: 1_000,
                  tunnels: [],
                  unexpected: true,
                }),
              ),
            ),
          ),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "GatewayControlError", reason: "invalid-response" });
      }),
    ),
  );

  it.effect("rejects URL credentials without exposing them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configPath = yield* writeTemporaryConfig({
          relayUrl: "https://user:must_not_leak@gateway.example",
          relaySecret: "test_secret",
        });
        const error = yield* runClient(
          configPath,
          HttpClient.make(() => Effect.die("gateway must not be contacted")),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({ reason: "invalid-url" });
        expect(JSON.stringify(error)).not.toContain("must_not_leak");
      }),
    ),
  );

  it.effect("redacts credentials from malformed gateway URLs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configPath = yield* writeTemporaryConfig({
          relayUrl: "https://user:must_not_leak@",
          relaySecret: "test_secret",
        });
        const error = yield* runClient(
          configPath,
          HttpClient.make(() => Effect.die("gateway must not be contacted")),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({ reason: "invalid-url", url: "invalid gateway URL" });
        expect(JSON.stringify(error)).not.toContain("must_not_leak");
      }),
    ),
  );

  it.effect("times out a gateway request after five seconds", () =>
    Effect.gen(function* () {
      const request = Effect.gen(function* () {
        return yield* (yield* GatewayControlClient).listTunnels;
      }).pipe(
        Effect.provide(GatewayControlClient.live),
        Effect.provideService(
          LocalConfigStore,
          LocalConfigStore.of({
            read: Effect.succeed({
              relayUrl: "http://127.0.0.1:3002",
              relaySecret: "test_secret",
            }),
            update: () => Effect.void,
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
      );
      const fiber = yield* request.pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);

      expect(error).toMatchObject({ _tag: "GatewayControlError", reason: "timeout" });
    }),
  );
});

function runClient(configPath: string, httpClient: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    return yield* (yield* GatewayControlClient).listTunnels;
  }).pipe(
    Effect.provide(GatewayControlClient.live),
    Effect.provide(LocalConfigStore.layer(configPath)),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(NodeServices.layer),
  );
}

const writeTemporaryConfig = (config: object) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "turbotunnel-list-"));
      const path = join(directory, "config.json");
      await writeFile(path, JSON.stringify(config));
      return path;
    }),
    (path) =>
      Effect.promise(() => rm(dirname(path), { recursive: true, force: true })).pipe(Effect.orDie),
  );
