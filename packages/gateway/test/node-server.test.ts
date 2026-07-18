import { createServer } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { GatewayListenError, listenNodeServer } from "../src/node-server.js";

describe("Node gateway server startup", () => {
  it.live("reports EADDRINUSE in the typed channel and cleans startup listeners", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = createServer();
        yield* Effect.addFinalizer(() => closeServer(owner));
        yield* listenNodeServer(owner, 0, "127.0.0.1");
        const address = owner.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("Test owner server did not bind to a TCP port.");
        }

        const contender = createServer();
        yield* Effect.addFinalizer(() => closeServer(contender));
        const error = yield* listenNodeServer(contender, address.port, "127.0.0.1").pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(GatewayListenError);
        expect(error).toMatchObject({ code: "EADDRINUSE", port: address.port });
        expect(contender.listenerCount("error")).toBe(0);
        expect(
          contender.rawListeners("listening").some((listener) => listener.name === "onListening"),
        ).toBe(false);
        expect(contender.listening).toBe(false);
      }),
    ),
  );

  it.live("closes a listener when listen acquisition is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = createServer();
        const fiber = yield* listenNodeServer(server, 0, "127.0.0.1").pipe(Effect.forkChild);
        yield* Fiber.interrupt(fiber);

        expect(server.listening).toBe(false);
        expect(server.listenerCount("error")).toBe(0);
        expect(
          server.rawListeners("listening").some((listener) => listener.name === "onListening"),
        ).toBe(false);
      }),
    ),
  );
});

function closeServer(server: ReturnType<typeof createServer>): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (!server.listening) return resume(Effect.void);
    server.close(() => resume(Effect.void));
  });
}
