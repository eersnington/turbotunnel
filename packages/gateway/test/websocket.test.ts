import { createServer, type IncomingMessage, type Server } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { PROTOCOL_VERSION } from "@turbotunnel/contracts";
import { Effect, Fiber } from "effect";
import { WebSocket, WebSocketServer } from "ws";

import { acquireGatewayWebSocket } from "../src/websocket.js";

describe("GatewayWebSocket", () => {
  it.live("reports an asynchronous raw socket write failure in the typed channel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireGatewayFixture;
        const connection = yield* Effect.forkChild(waitForConnection(fixture.webSocketServer));
        yield* acquireClient(`ws://127.0.0.1:${fixture.port}`);
        const { rawWebSocket, request } = yield* Fiber.join(connection);
        const socket = yield* acquireGatewayWebSocket(rawWebSocket);

        request.socket.destroy();
        const error = yield* socket
          .sendFrame({
            protocolVersion: PROTOCOL_VERSION,
            type: "error",
            frameId: "frm_write_failure",
            code: "TEST",
            message: "test",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GatewayWebSocketWriteError",
          operation: "send-frame",
        });
      }),
    ),
  );

  it.live("closes instead of buffering unbounded inbound events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireGatewayFixture;
        const connection = yield* Effect.forkChild(waitForConnection(fixture.webSocketServer));
        const client = yield* acquireClient(`ws://127.0.0.1:${fixture.port}`);
        yield* waitForOpen(client);
        const { rawWebSocket } = yield* Fiber.join(connection);
        yield* acquireGatewayWebSocket(rawWebSocket);
        const closed = yield* Effect.forkChild(waitForClientClose(client));

        for (let index = 0; index <= 256; index += 1) {
          client.send(String(index));
        }

        expect(yield* Fiber.join(closed)).toEqual({
          code: 1013,
          reason: "WebSocket event queue overflow",
        });
      }),
    ),
  );
});

type GatewayFixture = {
  readonly server: Server;
  readonly webSocketServer: WebSocketServer;
  readonly port: number;
};

const acquireGatewayFixture = Effect.gen(function* () {
  const { server, webSocketServer } = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const server = createServer();
      const webSocketServer = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) => {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request);
        });
      });
      return { server, webSocketServer };
    }),
    ({ server, webSocketServer }) =>
      closeWebSocketServer(webSocketServer).pipe(
        Effect.andThen(closeHttpServer(server)),
        Effect.orDie,
      ),
  );
  yield* listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.fail(
      new Error("Gateway WebSocket test server is not listening on a TCP port."),
    );
  }
  return { server, webSocketServer, port: address.port } satisfies GatewayFixture;
});

function listen(server: Server) {
  return Effect.callback<void, Error, never>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error));
    const onListening = () => resume(Effect.void);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", onListening);
    return Effect.sync(() => {
      server.off("error", onError);
      server.off("listening", onListening);
    });
  });
}

function acquireClient(url: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const client = new WebSocket(url);
      client.on("error", ignoreClientError);
      return client;
    }),
    (client) =>
      Effect.sync(() => {
        client.terminate();
      }),
  );
}

function waitForConnection(webSocketServer: WebSocketServer) {
  return Effect.callback<
    { readonly rawWebSocket: WebSocket; readonly request: IncomingMessage },
    never,
    never
  >((resume) => {
    const listener = (rawWebSocket: WebSocket, request: IncomingMessage) =>
      resume(Effect.succeed({ rawWebSocket, request }));
    webSocketServer.once("connection", listener);
    return Effect.sync(() => webSocketServer.off("connection", listener));
  }).pipe(Effect.timeout("1 second"));
}

function waitForOpen(client: WebSocket) {
  return Effect.callback<void, Error>((resume) => {
    const onOpen = () => resume(Effect.void);
    const onError = (error: Error) => resume(Effect.fail(error));
    client.once("open", onOpen);
    client.once("error", onError);
    return Effect.sync(() => {
      client.off("open", onOpen);
      client.off("error", onError);
    });
  }).pipe(Effect.timeout("1 second"));
}

function waitForClientClose(client: WebSocket) {
  return Effect.callback<{ readonly code: number; readonly reason: string }>((resume) => {
    const onClose = (code: number, reason: Buffer) =>
      resume(Effect.succeed({ code, reason: reason.toString("utf8") }));
    client.once("close", onClose);
    return Effect.sync(() => client.off("close", onClose));
  }).pipe(Effect.timeout("1 second"));
}

function closeWebSocketServer(webSocketServer: WebSocketServer) {
  return Effect.callback<void, Error, never>((resume) => {
    for (const webSocket of webSocketServer.clients) {
      webSocket.terminate();
    }
    webSocketServer.close((error) =>
      resume(error === undefined ? Effect.void : Effect.fail(error)),
    );
  });
}

function closeHttpServer(server: Server) {
  return Effect.callback<void, Error, never>((resume) => {
    server.close((error) => resume(error === undefined ? Effect.void : Effect.fail(error)));
  });
}

function ignoreClientError(): void {}
