import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import type { WsClose, WsData, WsOpen } from "@turbotunnel/contracts";
import { PROTOCOL_VERSION } from "@turbotunnel/contracts";
import { Effect, Exit, Fiber, Queue, Scope } from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { openLocalWebSocket } from "../src/runtime/forward-ws.js";

describe("openLocalWebSocket", () => {
  it.live("forwards local messages to relay ws.data frames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const frames = yield* makeRelayFrameRecorder;
        yield* openSocket(openFrame(), target(server), frames.push);

        const socket = yield* waitForConnection(server);
        socket.send("hello");

        const frame = yield* frames.take((value): value is WsData => value.type === "ws.data");
        expect(frame.connId).toBe("conn_test");
        expect(frame.browserOutTopic).toBe("browser-out");
        expect(frame.seq).toBe(0);
        expect(frame.binary).toBe(false);
        expect(Buffer.from(frame.data, "base64").toString("utf8")).toBe("hello");
      }),
    ),
  );

  it.live("forwards relay ws.data frames to the local socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const handle = yield* openSocket(openFrame(), target(server), () => {});

        const socket = yield* waitForConnection(server);
        const received = yield* Effect.forkChild(waitForMessage(socket));
        yield* handle.sendData(dataFrame({ text: "from-browser" }));

        expect((yield* Fiber.join(received)).toString("utf8")).toBe("from-browser");
      }),
    ),
  );

  it.live("queues relay data until the local socket opens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const handle = yield* openSocket(openFrame(), target(server), () => {});

        yield* handle.sendData(dataFrame({ text: "queued-before-open" }));

        const socket = yield* waitForConnection(server);
        expect((yield* waitForMessage(socket)).toString("utf8")).toBe("queued-before-open");
      }),
    ),
  );

  it.live("preserves binary frames in both directions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const frames = yield* makeRelayFrameRecorder;
        const handle = yield* openSocket(openFrame(), target(server), frames.push);

        const socket = yield* waitForConnection(server);
        socket.send(Buffer.from([1, 2, 3]), { binary: true });

        const relayFrame = yield* frames.take((value): value is WsData => value.type === "ws.data");
        expect(relayFrame.binary).toBe(true);
        expect(Buffer.from(relayFrame.data, "base64")).toEqual(Buffer.from([1, 2, 3]));

        const received = yield* Effect.forkChild(waitForMessage(socket));
        yield* handle.sendData(dataFrame({ bytes: Buffer.from([4, 5, 6]), binary: true }));

        expect(yield* Fiber.join(received)).toEqual(Buffer.from([4, 5, 6]));
      }),
    ),
  );

  it.live("passes websocket subprotocols separately from forwarded headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let forwardedHeader: string | string[] | undefined;
        let protocolHeader: string | string[] | undefined;
        const server = yield* listenWebSocketServer({
          handleProtocols: (protocols) => (protocols.has("proto-b") ? "proto-b" : false),
        });
        const connection = yield* Effect.forkChild(
          waitForConnection(server, (_socket, request) => {
            forwardedHeader = request.headers["x-test"];
            protocolHeader = request.headers["sec-websocket-protocol"];
          }),
        );

        yield* openSocket(
          openFrame({
            headers: [
              ["sec-websocket-protocol", "proto-a, proto-b"],
              ["x-test", "ok"],
            ],
          }),
          target(server),
          () => {},
        );

        const socket = yield* Fiber.join(connection);
        expect(forwardedHeader).toBe("ok");
        expect(protocolHeader).toContain("proto-a");
        expect(protocolHeader).toContain("proto-b");
        expect(socket.protocol).toBe("proto-b");
      }),
    ),
  );

  it.live("emits a relay close frame when the local socket closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const frames = yield* makeRelayFrameRecorder;
        yield* openSocket(openFrame(), target(server), frames.push);

        const socket = yield* waitForConnection(server);
        socket.close(4001, "done");

        const close = yield* frames.take((value): value is WsClose => value.type === "ws.close");
        expect(close.connId).toBe("conn_test");
        expect(close.browserOutTopic).toBe("browser-out");
        expect(close.code).toBe(4001);
        expect(close.reason).toBe("done");
      }),
    ),
  );

  it.live("does not echo a relay close when the browser side closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const frames = yield* makeRelayFrameRecorder;
        const handle = yield* openSocket(openFrame(), target(server), frames.push);

        yield* waitForConnection(server);
        yield* handle.close(closeFrame({ code: 1000, reason: "browser closed" }));
        yield* Effect.sleep("50 millis");

        expect(frames.values.filter((frame) => frame.type === "ws.close")).toEqual([]);
      }),
    ),
  );

  it.live("closes the local socket when its Effect scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const socketScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(socketScope, exit));
        yield* openLocalWebSocket(openFrame(), target(server), () => Effect.void).pipe(
          Effect.provideService(Scope.Scope, socketScope),
        );
        const socket = yield* waitForConnection(server);
        const closed = yield* Effect.forkChild(waitForClose(socket));
        yield* Effect.yieldNow;

        yield* Scope.close(socketScope, Exit.void);

        yield* Fiber.join(closed);
      }),
    ),
  );

  it.live("rejects invalid request paths without opening a local socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenWebSocketServer();
        const frames = yield* makeRelayFrameRecorder;

        const result = yield* Effect.exit(
          Effect.scoped(
            openLocalWebSocket(openFrame({ path: "not-origin-form" }), target(server), (frame) =>
              Effect.sync(() => frames.push(frame)),
            ),
          ),
        );

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(
            result.cause.reasons.some(
              (reason) =>
                reason._tag === "Fail" && reason.error._tag === "LocalWebSocketProtocolError",
            ),
          ).toBe(true);
        }
        expect(frames.values).toContainEqual(
          expect.objectContaining({ type: "ws.close", connId: "conn_test", code: 1008 }),
        );
      }),
    ),
  );
});

type RelayFrame = WsData | WsClose;

const makeRelayFrameRecorder = Effect.gen(function* () {
  const values: Array<RelayFrame> = [];
  const queue = yield* Queue.unbounded<RelayFrame>();
  const push = (frame: RelayFrame): void => {
    values.push(frame);
    Queue.offerUnsafe(queue, frame);
  };
  return {
    values,
    push,
    take: <A extends RelayFrame>(predicate: (frame: RelayFrame) => frame is A) =>
      takeFrame(queue, values, predicate),
  };
});

function takeFrame<A extends RelayFrame>(
  queue: Queue.Dequeue<RelayFrame>,
  values: ReadonlyArray<RelayFrame>,
  predicate: (frame: RelayFrame) => frame is A,
) {
  return Effect.gen(function* () {
    const existing = values.find(predicate);
    if (existing !== undefined) {
      return existing;
    }

    while (true) {
      yield* Queue.take(queue);
      const frame = values.find(predicate);
      if (frame !== undefined) {
        return frame;
      }
    }
  }).pipe(Effect.timeout("1 second"));
}

function openSocket(
  frame: WsOpen,
  localTarget: ReturnType<typeof target>,
  send: (frame: RelayFrame) => void,
) {
  return openLocalWebSocket(frame, localTarget, (relayFrame) =>
    Effect.sync(() => send(relayFrame)),
  );
}

function listenWebSocketServer(options: ConstructorParameters<typeof WebSocketServer>[0] = {}) {
  return Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0, ...options })),
      (server) => closeServer(server).pipe(Effect.orDie),
    );
    yield* waitForListening(server);
    return server;
  });
}

function closeServer(server: WebSocketServer) {
  return Effect.callback<void, Error, never>((resume) => {
    for (const client of server.clients) {
      client.terminate();
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.fail(error)));
  });
}

function waitForListening(server: WebSocketServer) {
  return Effect.callback<void, Error, never>((resume) => {
    if (server.address() !== null) {
      resume(Effect.void);
      return;
    }
    const onListening = () => resume(Effect.void);
    const onError = (error: Error) => resume(Effect.fail(error));
    server.once("listening", onListening);
    server.once("error", onError);
    return Effect.sync(() => {
      server.off("listening", onListening);
      server.off("error", onError);
    });
  });
}

function waitForConnection(
  server: WebSocketServer,
  onConnection?: (socket: WebSocket, request: IncomingMessage) => void,
) {
  return Effect.callback<WebSocket, never, never>((resume) => {
    const listener = (socket: WebSocket, request: IncomingMessage) => {
      onConnection?.(socket, request);
      resume(Effect.succeed(socket));
    };
    server.once("connection", listener);
    return Effect.sync(() => server.off("connection", listener));
  }).pipe(Effect.timeout("1 second"));
}

function waitForMessage(socket: WebSocket) {
  return Effect.callback<Buffer, never, never>((resume) => {
    const listener = (data: Buffer) => resume(Effect.succeed(data));
    socket.once("message", listener);
    return Effect.sync(() => socket.off("message", listener));
  }).pipe(Effect.timeout("1 second"));
}

function waitForClose(socket: WebSocket) {
  return Effect.callback<void, never, never>((resume) => {
    const listener = () => resume(Effect.void);
    socket.once("close", listener);
    return Effect.sync(() => socket.off("close", listener));
  }).pipe(Effect.timeout("1 second"));
}

function target(server: WebSocketServer): {
  readonly protocol: "http";
  readonly host: string;
  readonly port: number;
} {
  return { protocol: "http", host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

function openFrame(
  options: { readonly path?: string; readonly headers?: WsOpen["headers"] } = {},
): WsOpen {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.open",
    frameId: "frm_open",
    connId: "conn_test",
    browserOutTopic: "browser-out",
    localInTopic: "local-in",
    routeIdentity: {
      publicHost: "demo.test",
      policyFingerprint: "policy-v1:public",
      sessionId: "session_test",
    },
    path: options.path ?? "/socket",
    headers: options.headers ?? [],
  };
}

function dataFrame(options: {
  readonly text?: string;
  readonly bytes?: Buffer;
  readonly binary?: boolean;
}): WsData {
  const bytes = options.bytes ?? Buffer.from(options.text ?? "", "utf8");
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.data",
    frameId: "frm_data",
    connId: "conn_test",
    localInTopic: "local-in",
    seq: 0,
    data: bytes.toString("base64"),
    binary: options.binary ?? false,
  };
}

function closeFrame(options: { readonly code: number; readonly reason: string }): WsClose {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.close",
    frameId: "frm_close",
    connId: "conn_test",
    localInTopic: "local-in",
    code: options.code,
    reason: options.reason,
  };
}
