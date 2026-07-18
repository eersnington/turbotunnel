import {
  PRESENCE_TOPIC,
  PROTOCOL_VERSION,
  PRESENCE_REPLAY_EVENT_LIMIT,
  tunnelListResponseSchema,
  tunnelPresenceEventSchema,
  type TunnelPresenceEvent,
} from "@turbotunnel/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { hasValidBearerAuth } from "../src/auth.js";
import { GatewayState } from "../src/gateway-state.js";
import { GatewayConfig } from "../src/gateway-config.js";
import { runLocalClient } from "../src/local-client.js";
import { compactExpiredMemoryQueueEntries, MemoryQueue } from "../src/memory-queue.js";
import { listTunnels, PresenceReplayLimitError, reducePresence } from "../src/presence.js";
import { Queue, QueueSendError } from "../src/queue.js";
import type { GatewayWebSocket } from "../src/websocket.js";

const target = { protocol: "http", host: "127.0.0.1", port: 3000 } as const;

describe("tunnel presence", () => {
  it("compares relay bearer credentials in constant-time-compatible form", () => {
    expect(hasValidBearerAuth("Bearer relay_secret", "relay_secret")).toBe(true);
    expect(hasValidBearerAuth("Bearer wrong", "relay_secret")).toBe(false);
    expect(hasValidBearerAuth("Basic relay_secret", "relay_secret")).toBe(false);
    expect(hasValidBearerAuth(undefined, "relay_secret")).toBe(false);
  });

  it.effect("assigns in-memory message timestamps from the broker clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(12_345);
      const queue = yield* Queue;
      yield* queue.send("timestamp_test", { ok: true });
      const messages = yield* queue.receive({
        topic: "timestamp_test",
        consumerGroup: "timestamp_consumer",
        limit: 10,
        visibilityTimeoutSeconds: 30,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.sentAt).toBe(12_345);
    }).pipe(Effect.provide(MemoryQueue.isolatedLayer())),
  );

  it.effect("terminates a relay when its presence publication fails", () => {
    const closed: Array<{
      readonly code: number | undefined;
      readonly reason: string | undefined;
    }> = [];
    let received = false;
    const socket: GatewayWebSocket = {
      receive: Effect.sync(() => {
        if (received) {
          return { _tag: "Close", code: 1000, reason: "done" } as const;
        }
        received = true;
        return {
          _tag: "Message",
          binary: false,
          data: Buffer.from(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              type: "local.hello",
              frameId: "hello_failure",
              slug: "publication-failure",
              publicHost: "publication-failure.tunnel.test",
              accessPolicy: { type: "public" },
              localClientId: "client_failure",
              sessionId: "session_failure",
              generation: 1,
              capacity: 1,
              target,
            }),
          ),
        } as const;
      }),
      isOpen: Effect.succeed(true),
      sendFrame: () => Effect.succeed(true),
      sendData: () => Effect.succeed(true),
      close: (code, reason) => Effect.sync(() => closed.push({ code, reason })),
    };
    const failingQueue = Layer.succeed(
      Queue,
      Queue.of({
        send: (topic: string) =>
          Effect.fail(
            new QueueSendError({
              operation: "test presence send",
              topic,
              cause: "unavailable",
              message: "The test Queue is unavailable.",
            }),
          ),
        receive: () => Effect.succeed([]),
      }),
    );
    const layer = Layer.mergeAll(
      GatewayConfig.layerFromEnv({
        TURBOTUNNEL_BASE_DOMAIN: "tunnel.test",
        TURBOTUNNEL_RELAY_SECRET: "test_secret",
      }),
      GatewayState.layer,
      failingQueue,
    );

    return Effect.scoped(
      runLocalClient(socket, {
        host: "publication-failure.tunnel.test",
        authorization: "Bearer test_secret",
        cookie: undefined,
        realIp: undefined,
        forwardedFor: undefined,
        forwardedProto: "https",
        secWebSocketProtocols: [],
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.andThen(
        Effect.sync(() => {
          expect(closed).toContainEqual({
            code: 1011,
            reason: "gateway queue operation failed",
          });
        }),
      ),
    );
  });

  it.effect("uses the gateway clock fallback and sequences a clean disconnect", () => {
    const published: Array<unknown> = [];
    let received = false;
    const socket: GatewayWebSocket = {
      receive: Effect.sync(() => {
        if (received) return { _tag: "Close", code: 1000, reason: "done" } as const;
        received = true;
        return {
          _tag: "Message",
          binary: false,
          data: Buffer.from(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              type: "local.hello",
              frameId: "hello_fallback",
              slug: "clock-fallback",
              publicHost: "clock-fallback.tunnel.test",
              accessPolicy: { type: "public" },
              localClientId: "client_fallback",
              sessionId: "session_fallback",
              generation: 1,
              capacity: 1,
              target,
            }),
          ),
        } as const;
      }),
      isOpen: Effect.succeed(true),
      sendFrame: () => Effect.succeed(true),
      sendData: () => Effect.succeed(true),
      close: () => Effect.void,
    };
    const recordingQueue = Layer.succeed(
      Queue,
      Queue.of({
        send: (_topic: string, payload: unknown) =>
          Effect.sync(() => {
            published.push(payload);
          }),
        receive: () => Effect.succeed([]),
      }),
    );
    const layer = Layer.mergeAll(
      GatewayConfig.layerFromEnv({
        TURBOTUNNEL_BASE_DOMAIN: "tunnel.test",
        TURBOTUNNEL_RELAY_SECRET: "test_secret",
      }),
      GatewayState.layer,
      recordingQueue,
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(5_432);
      yield* Effect.scoped(
        runLocalClient(socket, {
          host: "clock-fallback.tunnel.test",
          authorization: undefined,
          cookie: undefined,
          realIp: undefined,
          forwardedFor: undefined,
          forwardedProto: "https",
          secWebSocketProtocols: [],
        }),
      );
      const decoded = published.map((payload) =>
        Schema.decodeUnknownResult(tunnelPresenceEventSchema)(payload),
      );
      expect(decoded.every(Result.isSuccess)).toBe(true);
      expect(
        decoded.flatMap((result) => (Result.isSuccess(result) ? [result.success] : [])),
      ).toEqual([
        expect.objectContaining({ type: "upsert", connectedAt: 5_432, sequence: 1 }),
        expect.objectContaining({ type: "remove", connectedAt: 5_432, sequence: 2 }),
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails instead of returning a partial list when replay stays non-empty", () => {
    let receives = 0;
    const continuousQueue = Layer.succeed(
      Queue,
      Queue.of({
        send: () => Effect.void,
        receive: (options) => {
          receives += 1;
          return Effect.succeed(
            Array.from({ length: options.limit }, (_, index) => ({
              id: `continuous_${receives}_${index}`,
              sentAt: 1_000,
              payload: event("refresh", "continuous", "session", "client", 1, receives),
              ack: Effect.void,
            })),
          );
        },
      }),
    );
    const layer = Layer.mergeAll(GatewayState.layer, continuousQueue);

    return Effect.gen(function* () {
      const result = yield* Effect.result(listTunnels());
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PresenceReplayLimitError);
        expect(result.failure).toMatchObject({ eventLimit: PRESENCE_REPLAY_EVENT_LIMIT });
      }
      expect(receives).toBe(PRESENCE_REPLAY_EVENT_LIMIT / 10 + 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reduces generations, removes disconnected relays, and groups a pool", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const queue = yield* Queue;
      yield* sendPresence(queue, event("upsert", "zeta", "session_pool", "client_a", 2));
      yield* TestClock.adjust(1);
      yield* sendPresence(queue, event("upsert", "zeta", "session_pool", "client_b", 1));
      yield* TestClock.adjust(1);
      yield* sendPresence(queue, event("remove", "zeta", "session_pool", "client_a", 1));
      yield* sendPresence(queue, event("upsert", "alpha", "session_alpha", "client_c", 1));

      const response = yield* listTunnels();
      expect(response.tunnels.map((tunnel) => tunnel.slug)).toEqual(["alpha", "zeta"]);
      expect(response.tunnels.find((tunnel) => tunnel.slug === "zeta")?.relayCount).toBe(2);
      expect(Result.isSuccess(Schema.decodeUnknownResult(tunnelListResponseSchema)(response))).toBe(
        true,
      );
    }).pipe(Effect.provide(presenceLayer())),
  );

  it("ignores out-of-order older timestamps within the same generation", () => {
    const refresh = event("refresh", "ordered", "session_ordered", "client_ordered", 3, 2);
    const remove = event("remove", "ordered", "session_ordered", "client_ordered", 3, 1);
    expect(
      reducePresence(
        [
          { event: refresh, sentAt: 20_000 },
          { event: remove, sentAt: 19_000 },
        ],
        20_001,
      ),
    ).toEqual([
      {
        slug: "ordered",
        sessionId: "session_ordered",
        target,
        connectedAt: 1_000,
        relayCount: 1,
      },
    ]);
  });

  it("keeps a newer disconnect ahead of a preceding refresh at the same broker timestamp", () => {
    expect(
      reducePresence(
        [
          {
            event: event("remove", "disconnect", "session", "client", 1, 3),
            sentAt: 20_000,
          },
          {
            event: event("refresh", "disconnect", "session", "client", 1, 2),
            sentAt: 20_000,
          },
        ],
        20_001,
      ),
    ).toEqual([]);
  });

  it("compacts expired messages, consumer bookkeeping, and idempotency keys", () => {
    const expiredConsumers = new Map([["tt_presence_list_old", 20_000]]);
    const state = {
      topics: new Map([
        [
          "presence",
          [
            { expiresAt: 10_000, consumers: expiredConsumers },
            { expiresAt: 30_000, consumers: new Map<string, number>() },
          ],
        ],
        ["expired_topic", [{ expiresAt: 5_000, consumers: expiredConsumers }]],
      ]),
      idempotencyKeys: new Map([
        ["expired", 10_000],
        ["live", 30_000],
      ]),
    };

    compactExpiredMemoryQueueEntries(state, 20_000);

    expect(state.topics.get("presence")).toEqual([{ expiresAt: 30_000, consumers: new Map() }]);
    expect(state.topics.has("expired_topic")).toBe(false);
    expect(state.idempotencyKeys).toEqual(new Map([["live", 30_000]]));
  });

  it("does not resurrect a fresh older generation after the newest generation expires", () => {
    expect(
      reducePresence(
        [
          {
            event: event("upsert", "stale", "session_stale", "client_stale", 2),
            sentAt: 10_000,
          },
          {
            event: event("refresh", "stale", "session_stale", "client_stale", 1),
            sentAt: 39_000,
          },
        ],
        41_000,
      ),
    ).toEqual([]);
  });

  it.effect("acks malformed events and excludes expired leases", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const queue = yield* Queue;
      yield* queue.send(PRESENCE_TOPIC, { version: 1, type: "upsert", unexpected: true });
      yield* sendPresence(queue, event("upsert", "expired", "session_old", "client_old", 1));
      yield* TestClock.adjust("31 seconds");

      const first = yield* listTunnels();
      const second = yield* listTunnels();
      expect(first.tunnels).toEqual([]);
      expect(second.tunnels).toEqual([]);
    }).pipe(Effect.provide(presenceLayer())),
  );
});

function presenceLayer() {
  return Layer.mergeAll(GatewayState.layer, MemoryQueue.isolatedLayer());
}

function event(
  type: TunnelPresenceEvent["type"],
  slug: string,
  sessionId: string,
  localClientId: string,
  generation: number,
  sequence = 1,
): TunnelPresenceEvent {
  return {
    version: 1,
    type,
    slug,
    publicHost: `${slug}.tunnel.test`,
    accessPolicy: { type: "public" },
    sessionId,
    localClientId,
    generation,
    sequence,
    target,
    connectedAt: 1_000,
  };
}

function sendPresence(queue: Queue["Service"], presence: TunnelPresenceEvent) {
  return queue.send(PRESENCE_TOPIC, presence, { ttlSeconds: 60 });
}
