import { Effect } from "effect";
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
