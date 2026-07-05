import { Buffer } from "node:buffer";

import { Effect, Layer, Option, Schema } from "effect";

import { GatewayConfig } from "./gateway-config.js";
import { OidcToken } from "./oidc-token.js";
import {
  Queue,
  QueueAckError,
  QueueAuthError,
  type QueueMessage,
  QueueReceiveError,
  QueueSendError,
  type ReceiveOptions,
  type SendOptions,
} from "./queue.js";

const ndjsonQueueMessageSchema = Schema.Struct({
  messageId: Schema.NonEmptyString,
  receiptHandle: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
});

type NdjsonQueueMessage = typeof ndjsonQueueMessageSchema.Type;

class VercelQueueLive {
  constructor(
    private readonly region: string,
    private readonly oidcToken: OidcToken["Service"],
  ) {}

  send<T>(
    topic: string,
    payload: T,
    options: SendOptions = {},
  ): Effect.Effect<void, QueueSendError | QueueAuthError> {
    const region = this.region;
    const oidcToken = this.oidcToken;
    return Effect.gen(function* () {
      const headers = yield* authHeaders(oidcToken);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${baseUrl(region)}/topic/${encodeURIComponent(topic)}`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              ...(options.ttlSeconds === undefined
                ? {}
                : { "vqs-retention-seconds": String(options.ttlSeconds) }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { "vqs-idempotency-key": options.idempotencyKey }),
            },
            body: JSON.stringify(payload),
          }),
        catch: (cause) =>
          new QueueSendError({
            operation: "send Vercel Queue message",
            topic,
            cause,
            message: "Unable to send a gateway message to Vercel Queue.",
          }),
      });

      if (response.status !== 201 && response.status !== 202) {
        return yield* new QueueSendError({
          operation: "send Vercel Queue message",
          topic,
          cause: { status: response.status },
          message: `Vercel Queue send failed with status ${response.status}.`,
        });
      }
    });
  }

  receive(
    options: ReceiveOptions,
  ): Effect.Effect<Array<QueueMessage>, QueueReceiveError | QueueAuthError> {
    const region = this.region;
    const oidcToken = this.oidcToken;
    return Effect.gen(function* () {
      const headers = yield* authHeaders(oidcToken);
      const url = `${baseUrl(region)}/topic/${encodeURIComponent(options.topic)}/consumer/${encodeURIComponent(options.consumerGroup)}`;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "POST",
            headers: {
              ...headers,
              accept: "application/x-ndjson",
              "vqs-max-messages": String(options.limit),
              "vqs-visibility-timeout-seconds": String(options.visibilityTimeoutSeconds),
            },
          }),
        catch: (cause) =>
          new QueueReceiveError({
            operation: "receive Vercel Queue messages",
            topic: options.topic,
            cause,
            message: "Unable to receive gateway messages from Vercel Queue.",
          }),
      });

      if (response.status === 204) {
        return [];
      }

      if (response.status !== 200) {
        return yield* new QueueReceiveError({
          operation: "receive Vercel Queue messages",
          topic: options.topic,
          cause: { status: response.status },
          message: `Vercel Queue receive failed with status ${response.status}.`,
        });
      }

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new QueueReceiveError({
            operation: "read Vercel Queue response body",
            topic: options.topic,
            cause,
            message: "Unable to read Vercel Queue response body.",
          }),
      });
      const messages: Array<NdjsonQueueMessage> = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const rawEnvelope = yield* Effect.try({
          try: (): unknown => JSON.parse(trimmed),
          catch: (cause) =>
            new QueueReceiveError({
              operation: "parse Vercel Queue envelope JSON",
              topic: options.topic,
              cause,
              message: "Vercel Queue response line was not valid JSON.",
            }),
        });
        const envelope = yield* Schema.decodeUnknownEffect(ndjsonQueueMessageSchema)(
          rawEnvelope,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new QueueReceiveError({
                operation: "parse Vercel Queue envelope",
                topic: options.topic,
                cause,
                message: "Vercel Queue response line did not match the expected envelope shape.",
              }),
          ),
        );
        messages.push(envelope);
      }

      const received: Array<QueueMessage> = [];
      for (const message of messages) {
        const payload = yield* Effect.try({
          try: (): unknown => JSON.parse(Buffer.from(message.body, "base64").toString("utf8")),
          catch: (cause) =>
            new QueueReceiveError({
              operation: "parse Vercel Queue message payload",
              topic: options.topic,
              cause,
              message: "Vercel Queue message payload was not valid JSON.",
            }),
        });

        received.push({
          id: message.messageId,
          payload,
          ack: ackMessage({
            region,
            oidcToken,
            topic: options.topic,
            consumerGroup: options.consumerGroup,
            receiptHandle: message.receiptHandle,
          }),
        });
      }

      return received;
    });
  }
}

export class VercelQueue {
  static readonly layer = Layer.effect(
    Queue,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const oidcToken = yield* OidcToken;
      return Queue.of(new VercelQueueLive(config.queueRegion, oidcToken));
    }),
  );
}

function ackMessage(input: {
  readonly region: string;
  readonly oidcToken: OidcToken["Service"];
  readonly topic: string;
  readonly consumerGroup: string;
  readonly receiptHandle: string;
}): Effect.Effect<void, QueueAckError | QueueAuthError> {
  return Effect.gen(function* () {
    const headers = yield* authHeaders(input.oidcToken);
    const url = `${baseUrl(input.region)}/topic/${encodeURIComponent(input.topic)}/consumer/${encodeURIComponent(input.consumerGroup)}/lease/${encodeURIComponent(input.receiptHandle)}`;
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { method: "DELETE", headers }),
      catch: (cause) =>
        new QueueAckError({
          operation: "ack Vercel Queue message",
          topic: input.topic,
          cause,
          message: "Unable to acknowledge a Vercel Queue message.",
        }),
    });

    if (response.status !== 204 && response.status !== 404 && response.status !== 409) {
      return yield* new QueueAckError({
        operation: "ack Vercel Queue message",
        topic: input.topic,
        cause: { status: response.status },
        message: `Vercel Queue ack failed with status ${response.status}.`,
      });
    }
  });
}

function authHeaders(
  oidcToken: OidcToken["Service"],
): Effect.Effect<Record<string, string>, QueueAuthError> {
  return Effect.gen(function* () {
    const token = yield* oidcToken.get;
    const rawToken = Option.getOrUndefined(token);
    if (rawToken === undefined || rawToken.length === 0) {
      return yield* new QueueAuthError({
        message:
          "Vercel Queue API requires an OIDC token, but this gateway instance has not received one yet. Retry after the tunnel reconnects; if this continues, enable Vercel OIDC for the project.",
      });
    }

    return { authorization: `Bearer ${rawToken}` };
  });
}

function baseUrl(region: string): string {
  return `https://${region}.vercel-queue.com/api/v3`;
}
