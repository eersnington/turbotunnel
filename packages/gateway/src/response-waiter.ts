import {
  httpResponseConsumerGroup,
  isHttpResponseFrame,
  parseProtocolFramePayload,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  type HttpResponse,
} from "@turbotunnel/contracts";
import { Clock, Effect, Result } from "effect";

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
export function waitForHttpResponseFromQueue(
  input: WaitForHttpResponseInput,
): Effect.Effect<WaitForHttpResponseResult, QueueAckError | QueueAuthError | QueueReceiveError> {
  return Effect.gen(function* () {
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
        const parsed = parseProtocolFramePayload(message.payload);
        if (Result.isFailure(parsed) || !isHttpResponseFrame(parsed.success)) {
          yield* message.ack;
          continue;
        }

        if (parsed.success.requestId !== input.requestId) {
          yield* message.ack;
          continue;
        }

        yield* message.ack;
        return { _tag: "ok", value: parsed.success };
      }

      yield* Effect.sleep("100 millis");
    }

    return { _tag: "timeout" };
  });
}
