import { Context, Effect, Schema } from "effect";

export type QueueMessage = {
  readonly id: string;
  readonly payload: unknown;
  readonly ack: Effect.Effect<void, QueueAckError | QueueAuthError>;
};

export type ReceiveOptions = {
  readonly topic: string;
  readonly consumerGroup: string;
  readonly limit: number;
  readonly visibilityTimeoutSeconds: number;
};

export type SendOptions = {
  readonly idempotencyKey?: string;
  readonly ttlSeconds?: number;
};

export class QueueSendError extends Schema.TaggedErrorClass<QueueSendError>()("QueueSendError", {
  operation: Schema.String,
  topic: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class QueueReceiveError extends Schema.TaggedErrorClass<QueueReceiveError>()(
  "QueueReceiveError",
  {
    operation: Schema.String,
    topic: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class QueueAckError extends Schema.TaggedErrorClass<QueueAckError>()("QueueAckError", {
  operation: Schema.String,
  topic: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class QueueAuthError extends Schema.TaggedErrorClass<QueueAuthError>()("QueueAuthError", {
  message: Schema.String,
}) {}

export class Queue extends Context.Service<
  Queue,
  {
    send<T>(
      topic: string,
      payload: T,
      options?: SendOptions,
    ): Effect.Effect<void, QueueSendError | QueueAuthError>;
    receive(
      options: ReceiveOptions,
    ): Effect.Effect<Array<QueueMessage>, QueueReceiveError | QueueAuthError>;
  }
>()("turbotunnel/gateway/Queue") {}
