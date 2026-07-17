import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { acquireLocalWebSocket } from "../src/adapters/websocket.js";

describe("local WebSocket adapter", () => {
  it.effect("reports connection refusal as a typed connect failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* acquireLocalWebSocket({
            url: "ws://127.0.0.1:1/",
            protocols: [],
            headers: {},
          });
          return yield* socket.receive;
        }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("LocalWebSocketConnectError");
    }),
  );
});
