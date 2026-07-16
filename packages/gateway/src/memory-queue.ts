import { Clock, Context, Effect, Layer } from "effect";

import { Queue, type QueueMessage, type ReceiveOptions, type SendOptions } from "./queue.js";

type StoredMessage = {
  readonly id: string;
  readonly sentAt: number;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly idempotencyKey: string | undefined;
  readonly leasedUntilByConsumer: Map<string, number>;
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
  static makeLayer() {
    return Layer.succeed(
      this,
      this.of({ topics: new Map(), idempotencyKeys: new Map(), nextId: 1 }),
    );
  }

  static readonly shared = this.makeLayer();
}

class MemoryQueueLive {
  constructor(private readonly state: MemoryQueueStateValue) {}

  send<T>(topic: string, payload: T, options: SendOptions = {}): Effect.Effect<void> {
    const state = this.state;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      compactExpiredMemoryQueueEntries(state, now);
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
        sentAt: now,
        payload,
        expiresAt: now + ttlMs,
        idempotencyKey: options.idempotencyKey,
        leasedUntilByConsumer: new Map(),
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
      compactExpiredMemoryQueueEntries(state, now);
      const messages = state.topics.get(options.topic) ?? [];
      const visible = messages.filter(
        (message) =>
          message.expiresAt > now &&
          (message.leasedUntilByConsumer.get(options.consumerGroup) ?? 0) <= now &&
          !message.acknowledgedBy.has(options.consumerGroup),
      );

      return visible.slice(0, options.limit).map((message) => {
        message.leasedUntilByConsumer.set(
          options.consumerGroup,
          now + options.visibilityTimeoutSeconds * 1000,
        );
        return {
          id: message.id,
          sentAt: message.sentAt,
          payload: message.payload,
          ack: Effect.sync(() => {
            message.acknowledgedBy.add(options.consumerGroup);
          }),
        };
      });
    });
  }
}

/** Removes expired broker data, including per-request consumer-group bookkeeping. */
export function compactExpiredMemoryQueueEntries<T extends { readonly expiresAt: number }>(
  state: {
    readonly topics: Map<string, Array<T>>;
    readonly idempotencyKeys: Map<string, number>;
  },
  now: number,
): void {
  for (const [topic, messages] of state.topics) {
    const retained = messages.filter((message) => message.expiresAt > now);
    if (retained.length === 0) {
      state.topics.delete(topic);
    } else if (retained.length !== messages.length) {
      state.topics.set(topic, retained);
    }
  }
  for (const [key, expiresAt] of state.idempotencyKeys) {
    if (expiresAt <= now) {
      state.idempotencyKeys.delete(key);
    }
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

  /** Fresh broker state for isolated runtimes and seam-level tests. */
  static isolatedLayer() {
    return this.layer.pipe(Layer.provide(MemoryQueueState.makeLayer()));
  }
}
