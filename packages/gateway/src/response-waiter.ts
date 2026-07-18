import {
  httpResponseConsumerGroup,
  decodeHttpResponseFramePayload,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  type HttpResponse,
} from "@turbotunnel/contracts";
import { Effect, Option } from "effect";

import type { GatewayMetric } from "./gateway-state.js";

import type { Queue, QueueAckError, QueueAuthError, QueueReceiveError } from "./queue.js";

export type WaitForHttpResponseInput = {
  readonly queue: Queue["Service"];
  readonly requestId: string;
  readonly responseTopic: string;
  readonly timeoutMs?: number;
  readonly recordMetric?: (metric: GatewayMetric) => Effect.Effect<void>;
};

export type WaitForHttpResponseResult =
  | { readonly _tag: "ok"; readonly value: HttpResponse }
  | { readonly _tag: "timeout" };

/** Polls and acknowledges a request response topic until a match, timeout, or fiber interruption. */
export const waitForHttpResponseFromQueue = Effect.fn("waitForHttpResponseFromQueue")(function* (
  input: WaitForHttpResponseInput,
): Effect.fn.Return<WaitForHttpResponseResult, QueueAckError | QueueAuthError | QueueReceiveError> {
  const consumerGroup = httpResponseConsumerGroup(input.requestId);
  const recordMetric = input.recordMetric ?? (() => Effect.void);
  const wait = Effect.gen(function* () {
    while (true) {
      const messages = yield* input.queue.receive({
        topic: input.responseTopic,
        consumerGroup,
        limit: QUEUE_RECEIVE_LIMIT,
        visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      });
      yield* recordMetric("queueReceives");

      for (const message of messages) {
        const parsed = yield* decodeHttpResponseFramePayload(message.payload).pipe(
          Effect.map(Option.some),
          Effect.catchTags({ ProtocolPayloadDecodeError: () => Effect.succeed(Option.none()) }),
        );
        yield* message.ack;
        yield* recordMetric("queueAcks");
        if (Option.isSome(parsed) && parsed.value.requestId === input.requestId) {
          return parsed.value;
        }
      }

      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeoutOption(input.timeoutMs ?? PUBLIC_HTTP_TIMEOUT_MS));

  const result = yield* wait;
  return Option.match(result, {
    onNone: () => ({ _tag: "timeout" }) as const,
    onSome: (value) => ({ _tag: "ok", value }) as const,
  });
});
