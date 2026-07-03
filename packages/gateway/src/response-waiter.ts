import {
  httpResponseConsumerGroup,
  isHttpResponseFrame,
  parseProtocolFramePayload,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  type HttpResponse,
} from "@repo/turbotunnel-protocol";
import { Effect, Result } from "effect";

import type { Queue, QueueAckError, QueueAuthError, QueueReceiveError } from "./queue.js";

export type WaitForHttpResponseInput = {
  readonly queue: Queue["Service"];
  readonly requestId: string;
  readonly responseTopic: string;
  readonly timeoutMs?: number;
  readonly isCancelled?: () => boolean;
};

export type WaitForHttpResponseResult =
  | { readonly _tag: "ok"; readonly value: HttpResponse }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "cancelled" };

export function waitForHttpResponseFromQueue(
  input: WaitForHttpResponseInput,
): Effect.Effect<WaitForHttpResponseResult, QueueAckError | QueueAuthError | QueueReceiveError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + (input.timeoutMs ?? PUBLIC_HTTP_TIMEOUT_MS);
    const consumerGroup = httpResponseConsumerGroup(input.requestId);

    while (Date.now() < deadline) {
      if (input.isCancelled?.() === true) {
        return { _tag: "cancelled" };
      }

      const messages = yield* input.queue.receive<unknown>({
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
