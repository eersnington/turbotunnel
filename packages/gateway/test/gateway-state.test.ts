import { Effect, Exit, Scope } from "effect";
import { describe, expect, test } from "vitest";

import { GatewayState } from "../src/gateway-state.js";
import type { GatewayWebSocket } from "../src/websocket.js";

const inertSocket: GatewayWebSocket = {
  receive: Effect.never,
  isOpen: Effect.succeed(true),
  sendFrame: () => Effect.succeed(false),
  sendData: () => Effect.succeed(false),
  close: () => Effect.void,
};

describe("GatewayState", () => {
  test("keeps a newer local-client generation when the older registration scope closes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* GatewayState;
        const olderScope = yield* Scope.make();
        const newerScope = yield* Scope.make();
        const older = yield* state
          .registerLocalClient(localRegistration(1))
          .pipe(Effect.provideService(Scope.Scope, olderScope));
        const newer = yield* state
          .registerLocalClient(localRegistration(2))
          .pipe(Effect.provideService(Scope.Scope, newerScope));

        const beforeOlderCloses = yield* state.pickLocalClient("demo");
        yield* Scope.close(olderScope, Exit.void);
        const afterOlderCloses = yield* state.pickLocalClient("demo");
        yield* Scope.close(newerScope, Exit.void);

        return { older, newer, beforeOlderCloses, afterOlderCloses };
      }).pipe(Effect.provide(GatewayState.layer)),
    );

    expect(result.beforeOlderCloses).toBe(result.newer);
    expect(result.beforeOlderCloses).not.toBe(result.older);
    expect(result.afterOlderCloses).toBe(result.newer);
  });

  test("owns public connection capacity for the registration scope", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* GatewayState;
        const firstRound = yield* Effect.scoped(
          Effect.all(
            [
              state.registerPublicConnection(registration("ws_first")),
              state.registerPublicConnection(registration("ws_second")),
            ],
            { concurrency: "unbounded" },
          ),
        );
        const afterRelease = yield* Effect.scoped(
          state.registerPublicConnection(registration("ws_after_release")),
        );
        return { firstRound, afterRelease };
      }).pipe(Effect.provide(GatewayState.layer)),
    );

    expect(result.firstRound.map((entry) => entry._tag).sort()).toEqual([
      "AtCapacity",
      "Registered",
    ]);
    expect(result.afterRelease._tag).toBe("Registered");
  });
});

function localRegistration(generation: number) {
  return {
    slug: "demo",
    socket: inertSocket,
    clientId: "local_generation_test",
    sessionId: "session_generation_test",
    generation,
    capacity: 1,
    target: { protocol: "http", host: "127.0.0.1", port: 4321 },
  } as const;
}

function registration(connId: string) {
  return {
    connId,
    slug: "demo",
    socket: inertSocket,
    browserOutTopic: `browser-${connId}`,
    localInTopic: `local-${connId}`,
    localClient: undefined,
    capacity: 1,
  } as const;
}
