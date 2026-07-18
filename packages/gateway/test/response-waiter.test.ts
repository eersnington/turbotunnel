import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { Queue } from "../src/queue.js";
import { waitForHttpResponseFromQueue } from "../src/response-waiter.js";

describe("queued HTTP response waiter", () => {
  it.effect("bounds a stalled receive and interrupts its fetch-like acquisition", () =>
    Effect.gen(function* () {
      const receiveStarted = yield* Deferred.make<void>();
      const receiveInterrupted = yield* Deferred.make<void>();
      const queue = stalledQueue(receiveStarted, receiveInterrupted);
      const fiber = yield* waitForHttpResponseFromQueue({
        queue,
        requestId: "req_timeout",
        responseTopic: "response-topic",
        timeoutMs: 1_000,
      }).pipe(Effect.forkChild);

      yield* Deferred.await(receiveStarted);
      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "timeout" });
      yield* Deferred.await(receiveInterrupted);
    }),
  );

  it.effect("records successful receives and acknowledgements", () =>
    Effect.gen(function* () {
      const metrics = yield* Ref.make<Array<string>>([]);
      const result = yield* waitForHttpResponseFromQueue({
        queue: {
          send: () => Effect.void,
          receive: () =>
            Effect.succeed([
              {
                id: "message-1",
                sentAt: 0,
                payload: {
                  protocolVersion: 1,
                  type: "http.response",
                  frameId: "frm_response",
                  requestId: "req_metrics",
                  responseTopic: "response-topic",
                  status: 200,
                  headers: [],
                  body: "",
                },
                ack: Effect.void,
              },
            ]),
        },
        requestId: "req_metrics",
        responseTopic: "response-topic",
        recordMetric: (metric) => Ref.update(metrics, (values) => [...values, metric]),
      });

      expect(result._tag).toBe("ok");
      expect(yield* Ref.get(metrics)).toEqual(["queueReceives", "queueAcks"]);
    }),
  );
});

function stalledQueue(
  started: Deferred.Deferred<void>,
  interrupted: Deferred.Deferred<void>,
): Queue["Service"] {
  return {
    send: () => Effect.void,
    receive: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
        return [];
      }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
  };
}
