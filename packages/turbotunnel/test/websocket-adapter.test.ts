import type { AddressInfo } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { WebSocketServer, type WebSocket } from "ws";

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

  it.live("fails and closes the socket when raw events exceed bounded capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
          closeServer,
        );
        yield* waitForListening(server);
        const connection = yield* Effect.forkChild(waitForConnection(server));
        const socket = yield* acquireLocalWebSocket({
          url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
          protocols: [],
          headers: {},
          eventQueueCapacity: 1,
        });
        expect((yield* socket.receive)._tag).toBe("Open");

        const peer = yield* Fiber.join(connection);
        const closed = yield* Effect.forkChild(waitForClose(peer));
        peer.send("first");
        peer.send("overflow");
        yield* Fiber.join(closed);

        expect((yield* socket.receive)._tag).toBe("Message");
        const error = yield* socket.receive.pipe(Effect.flip);
        expect(error._tag).toBe("LocalWebSocketConnectError");
      }),
    ),
  );
});

function waitForListening(server: WebSocketServer) {
  return Effect.callback<void, Error>((resume) => {
    server.once("listening", () => resume(Effect.void));
    server.once("error", (error) => resume(Effect.fail(error)));
  });
}

function waitForConnection(server: WebSocketServer) {
  return Effect.callback<WebSocket>((resume) => {
    server.once("connection", (socket) => resume(Effect.succeed(socket)));
  });
}

function waitForClose(socket: WebSocket) {
  return Effect.callback<void>((resume) => {
    socket.once("close", () => resume(Effect.void));
  });
}

function closeServer(server: WebSocketServer) {
  return Effect.callback<void>((resume) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resume(Effect.void));
  });
}
