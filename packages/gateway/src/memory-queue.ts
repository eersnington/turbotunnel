import { Clock, Context, Effect, Layer } from "effect";

import { Queue, type QueueMessage, type ReceiveOptions, type SendOptions } from "./queue.js";

type StoredMessage = {
  readonly id: string;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly idempotencyKey: string | undefined;
  leasedUntil: number;
  acknowledgedBy: Set<string>;
};

type MemoryQueueStateValue = {
  readonly topics: Map<string, Array<StoredMessage>>;
  readonly idempotencyKeys: Map<string, number>;
  nextId: number;
};

/** Explicit shared broker state used by all in-process gateway runtimes. */
class MemoryQueueState extends Context.Service<MemoryQueueState, MemoryQueueStateValue>()(
  "turbotunnel/gateway/MemoryQueueState",
) {
  static readonly shared = Layer.succeed(
    this,
    this.of({ topics: new Map(), idempotencyKeys: new Map(), nextId: 1 }),
  );
}

class MemoryQueueLive {
  constructor(private readonly state: MemoryQueueStateValue) {}

  send<T>(topic: string, payload: T, options: SendOptions = {}): Effect.Effect<void> {
    const state = this.state;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const ttlMs = (options.ttlSeconds ?? 60) * 1000;
      const dedupeKey =
        options.idempotencyKey === undefined ? undefined : `${topic}:${options.idempotencyKey}`;

      if (dedupeKey !== undefined) {
        const existingExpiresAt = state.idempotencyKeys.get(dedupeKey);
        if (existingExpiresAt !== undefined && existingExpiresAt > now) {
          return;
        }
        state.idempotencyKeys.set(dedupeKey, now + ttlMs);
      }

      const messages = state.topics.get(topic) ?? [];
      messages.push({
        id: `mem_${state.nextId.toString(36)}`,
        payload,
        expiresAt: now + ttlMs,
        idempotencyKey: options.idempotencyKey,
        leasedUntil: 0,
        acknowledgedBy: new Set(),
      });
      state.nextId += 1;
      state.topics.set(topic, messages);
    });
  }

  receive(options: ReceiveOptions): Effect.Effect<Array<QueueMessage>> {
    const state = this.state;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const messages = state.topics.get(options.topic) ?? [];
      const visible = messages.filter(
        (message) =>
          message.expiresAt > now &&
          message.leasedUntil <= now &&
          !message.acknowledgedBy.has(options.consumerGroup),
      );

      return visible.slice(0, options.limit).map((message) => {
        message.leasedUntil = now + options.visibilityTimeoutSeconds * 1000;
        return {
          id: message.id,
          payload: message.payload,
          ack: Effect.sync(() => {
            message.acknowledgedBy.add(options.consumerGroup);
          }),
        };
      });
    });
  }
}

export class MemoryQueue {
  static readonly layer = Layer.effect(
    Queue,
    Effect.gen(function* () {
      const state = yield* MemoryQueueState;
      return Queue.of(new MemoryQueueLive(state));
    }),
  );

  /** Queue implementation plus the shared in-memory broker it requires. */
  static readonly sharedLayer = this.layer.pipe(Layer.provide(MemoryQueueState.shared));
}
