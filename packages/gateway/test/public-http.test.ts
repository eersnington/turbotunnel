import { Buffer } from "node:buffer";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import {
  readLimitedBody,
  RequestBodyReadError,
  RequestBodyTooLargeError,
} from "../src/public-http.js";

describe("public HTTP request bodies", () => {
  it.effect("reports an oversized body in the typed error channel", () =>
    Effect.gen(function* () {
      const request = new IncomingMessage(new Socket());
      const result = yield* Effect.forkChild(Effect.flip(readLimitedBody(request, 3)));
      yield* Effect.yieldNow;

      request.emit("data", Buffer.from("four"));

      const error = yield* Fiber.join(result);
      expect(error).toBeInstanceOf(RequestBodyTooLargeError);
      expect(error).toMatchObject({ limitBytes: 3 });
      expect(request.readableFlowing).toBe(true);
      expect(request.listenerCount("data")).toBe(0);
    }),
  );

  it.effect("reports a body stream failure in the typed error channel", () =>
    Effect.gen(function* () {
      const request = new IncomingMessage(new Socket());
      const result = yield* Effect.forkChild(Effect.flip(readLimitedBody(request, 3)));
      yield* Effect.yieldNow;

      request.emit("error", new Error("stream failed"));

      const error = yield* Fiber.join(result);
      expect(error).toBeInstanceOf(RequestBodyReadError);
    }),
  );
});
