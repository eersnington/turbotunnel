import { Effect, Layer } from "effect";

import { Queue, type QueueMessage, type ReceiveOptions, type SendOptions } from "./queue.js";

type StoredMessage = {
  readonly id: string;
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly idempotencyKey: string | undefined;
  leasedUntil: number;
  acknowledgedBy: Set<string>;
};

type SharedState = {
  readonly topics: Map<string, Array<StoredMessage>>;
  readonly idempotencyKeys: Map<string, number>;
  nextId: number;
};

const defaultState: SharedState = {
  topics: new Map(),
  idempotencyKeys: new Map(),
  nextId: 1,
};

class MemoryQueueLive {
  constructor(private readonly state: SharedState = defaultState) {}

  send<T>(topic: string, payload: T, options: SendOptions = {}): Effect.Effect<void> {
    return Effect.sync(() => {
      const now = Date.now();
      const ttlMs = (options.ttlSeconds ?? 60) * 1000;
      const dedupeKey =
        options.idempotencyKey === undefined ? undefined : `${topic}:${options.idempotencyKey}`;

      if (dedupeKey !== undefined) {
        const existingExpiresAt = this.state.idempotencyKeys.get(dedupeKey);
        if (existingExpiresAt !== undefined && existingExpiresAt > now) {
          return;
        }
        this.state.idempotencyKeys.set(dedupeKey, now + ttlMs);
      }

      const messages = this.state.topics.get(topic) ?? [];
      messages.push({
        id: `mem_${this.state.nextId.toString(36)}`,
        payload,
        expiresAt: now + ttlMs,
        idempotencyKey: options.idempotencyKey,
        leasedUntil: 0,
        acknowledgedBy: new Set(),
      });
      this.state.nextId += 1;
      this.state.topics.set(topic, messages);
    });
  }

  receive(options: ReceiveOptions): Effect.Effect<Array<QueueMessage>> {
    return Effect.sync(() => {
      const now = Date.now();
      const messages = this.state.topics.get(options.topic) ?? [];
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
    Effect.sync(() => Queue.of(new MemoryQueueLive())),
  );
}
