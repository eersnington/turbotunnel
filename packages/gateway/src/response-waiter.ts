import {
  httpResponseConsumerGroup,
  decodeHttpResponseFramePayload,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  type HttpResponse,
} from "@turbotunnel/contracts";
import { Clock, Effect, Option } from "effect";

import type { Queue, QueueAckError, QueueAuthError, QueueReceiveError } from "./queue.js";

export type WaitForHttpResponseInput = {
  readonly queue: Queue["Service"];
  readonly requestId: string;
  readonly responseTopic: string;
  readonly timeoutMs?: number;
};

export type WaitForHttpResponseResult =
  | { readonly _tag: "ok"; readonly value: HttpResponse }
  | { readonly _tag: "timeout" };

/** Polls and acknowledges a request response topic until a match, timeout, or fiber interruption. */
export const waitForHttpResponseFromQueue = Effect.fn("waitForHttpResponseFromQueue")(function* (
  input: WaitForHttpResponseInput,
): Effect.fn.Return<WaitForHttpResponseResult, QueueAckError | QueueAuthError | QueueReceiveError> {
  const deadline = (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? PUBLIC_HTTP_TIMEOUT_MS);
  const consumerGroup = httpResponseConsumerGroup(input.requestId);

  while ((yield* Clock.currentTimeMillis) < deadline) {
    const messages = yield* input.queue.receive({
      topic: input.responseTopic,
      consumerGroup,
      limit: QUEUE_RECEIVE_LIMIT,
      visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    });

    for (const message of messages) {
      const parsed = yield* decodeHttpResponseFramePayload(message.payload).pipe(
        Effect.map(Option.some),
        Effect.catchTags({ ProtocolPayloadDecodeError: () => Effect.succeed(Option.none()) }),
      );
      if (Option.isNone(parsed)) {
        yield* message.ack;
        continue;
      }

      if (parsed.value.requestId !== input.requestId) {
        yield* message.ack;
        continue;
      }

      yield* message.ack;
      return { _tag: "ok", value: parsed.value };
    }

    yield* Effect.sleep("100 millis");
  }

  return { _tag: "timeout" };
});
