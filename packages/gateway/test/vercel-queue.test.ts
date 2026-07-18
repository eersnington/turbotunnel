import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import { QueueReceiveError } from "../src/queue.js";
import { readBoundedResponseBody } from "../src/vercel-queue.js";

describe("Vercel Queue response bodies", () => {
  it.effect("cancels a streaming response as soon as its byte limit is exceeded", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
          },
          cancel() {
            return Effect.runPromise(Deferred.succeed(cancelled, undefined)).then(() => undefined);
          },
        }),
      );

      const error = yield* readBoundedResponseBody(response, "topic", 3).pipe(Effect.flip);
      expect(error).toBeInstanceOf(QueueReceiveError);
      expect(error.operation).toBe("read Vercel Queue response body");
      yield* Deferred.await(cancelled);
    }),
  );

  it.effect("reads a response at the configured limit", () =>
    Effect.gen(function* () {
      const response = new Response(new TextEncoder().encode("abc"));
      expect(yield* readBoundedResponseBody(response, "topic", 3)).toBe("abc");
    }),
  );
});
