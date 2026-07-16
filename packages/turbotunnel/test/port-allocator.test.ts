import { createServer } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { PortAllocator } from "../src/adapters/port-allocator.js";

describe("PortAllocator", () => {
  it.effect("returns a port that can be bound after the reservation is released", () =>
    Effect.gen(function* () {
      const port = yield* Effect.gen(function* () {
        return yield* (yield* PortAllocator).freePort;
      }).pipe(Effect.provide(PortAllocator.live));

      yield* bindOnce(port);
      expect(port).toBeGreaterThan(0);
    }),
  );
});

function bindOnce(port: number): Effect.Effect<void, Error> {
  return Effect.callback((resume) => {
    const server = createServer();
    server.once("error", (cause) => resume(Effect.fail(cause)));
    server.listen(port, "127.0.0.1", () => {
      server.close((cause) =>
        cause === undefined ? resume(Effect.void) : resume(Effect.fail(cause)),
      );
    });
    return Effect.sync(() => server.close());
  });
}
