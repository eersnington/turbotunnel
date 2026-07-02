import {
  httpResponseConsumerGroup,
  isHttpResponseFrame,
  parseProtocolFramePayload,
  PUBLIC_HTTP_TIMEOUT_MS,
  QUEUE_RECEIVE_LIMIT,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  type HttpResponse,
} from "@repo/turbotunnel-protocol";
import { Result } from "effect";

import type { Broker } from "./broker.js";

export type WaitForHttpResponseInput = {
  readonly broker: Broker;
  readonly requestId: string;
  readonly responseTopic: string;
  readonly timeoutMs?: number;
  readonly isCancelled?: () => boolean;
};

export type WaitForHttpResponseResult =
  | { readonly _tag: "ok"; readonly value: HttpResponse }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "cancelled" };

export async function waitForHttpResponseFromQueue(
  input: WaitForHttpResponseInput,
): Promise<WaitForHttpResponseResult> {
  const deadline = Date.now() + (input.timeoutMs ?? PUBLIC_HTTP_TIMEOUT_MS);
  const consumerGroup = httpResponseConsumerGroup(input.requestId);

  while (Date.now() < deadline) {
    if (input.isCancelled?.() === true) {
      return { _tag: "cancelled" };
    }

    const messages = await input.broker.receive<unknown>({
      topic: input.responseTopic,
      consumerGroup,
      limit: QUEUE_RECEIVE_LIMIT,
      visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    });

    for (const message of messages) {
      const parsed = parseProtocolFramePayload(message.payload);
      if (Result.isFailure(parsed) || !isHttpResponseFrame(parsed.success)) {
        await message.ack();
        continue;
      }

      if (parsed.success.requestId !== input.requestId) {
        await message.ack();
        continue;
      }

      await message.ack();
      return { _tag: "ok", value: parsed.success };
    }

    await sleep(100);
  }

  return { _tag: "timeout" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
