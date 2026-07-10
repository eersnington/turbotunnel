import { createServer } from "node:http";

import { PROTOCOL_VERSION } from "@turbotunnel/contracts";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { acquireGatewayWebSocket } from "../src/websocket.js";

describe("GatewayWebSocket", () => {
  test("reports an asynchronous raw socket write failure in the typed channel", async () => {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const failure = new Promise<unknown>((resolve, reject) => {
      webSocketServer.once("connection", (rawWebSocket, request) => {
        void Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* acquireGatewayWebSocket(rawWebSocket);
              request.socket.destroy();
              return yield* socket.sendFrame({
                protocolVersion: PROTOCOL_VERSION,
                type: "error",
                frameId: "frm_write_failure",
                code: "TEST",
                message: "test",
              });
            }),
          ).pipe(Effect.flip),
        ).then(resolve, reject);
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Gateway WebSocket test server is not listening on a TCP port.");
    }
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on("error", () => {});
    try {
      const error = await failure;
      expect(error).toMatchObject({
        _tag: "GatewayWebSocketWriteError",
        operation: "send-frame",
      });
    } finally {
      client.terminate();
      for (const webSocket of webSocketServer.clients) {
        webSocket.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      });
    }
  });
});
