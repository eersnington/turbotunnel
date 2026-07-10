import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import type { WsClose, WsData, WsOpen } from "@turbotunnel/contracts";
import { PROTOCOL_VERSION } from "@turbotunnel/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { openLocalWebSocket } from "../src/runtime/forward-ws.js";

const servers: Array<WebSocketServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("openLocalWebSocket", () => {
  test("forwards local messages to relay ws.data frames", async () => {
    const server = await listenWebSocketServer();
    const frames = new RelayFrameRecorder();
    const handle = openLocalWebSocket(openFrame(), target(server), (frame) => frames.push(frame));

    const socket = await waitForConnection(server);
    socket.send("hello");

    const frame = await frames.take((value): value is WsData => value.type === "ws.data");
    expect(handle).toBeDefined();
    expect(frame.connId).toBe("conn_test");
    expect(frame.browserOutTopic).toBe("browser-out");
    expect(frame.seq).toBe(0);
    expect(frame.binary).toBe(false);
    expect(Buffer.from(frame.data, "base64").toString("utf8")).toBe("hello");

    handle?.dispose();
  });

  test("forwards relay ws.data frames to the local socket", async () => {
    const server = await listenWebSocketServer();
    const handle = openLocalWebSocket(openFrame(), target(server), () => {});

    const socket = await waitForConnection(server);
    const received = waitForMessage(socket);
    handle?.sendData(dataFrame({ text: "from-browser" }));

    expect((await received).toString("utf8")).toBe("from-browser");
    handle?.dispose();
  });

  test("queues relay data until the local socket opens", async () => {
    const server = await listenWebSocketServer();
    const handle = openLocalWebSocket(openFrame(), target(server), () => {});

    handle?.sendData(dataFrame({ text: "queued-before-open" }));

    const socket = await waitForConnection(server);
    expect((await waitForMessage(socket)).toString("utf8")).toBe("queued-before-open");
    handle?.dispose();
  });

  test("preserves binary frames in both directions", async () => {
    const server = await listenWebSocketServer();
    const frames = new RelayFrameRecorder();
    const handle = openLocalWebSocket(openFrame(), target(server), (frame) => frames.push(frame));

    const socket = await waitForConnection(server);
    socket.send(Buffer.from([1, 2, 3]), { binary: true });

    const relayFrame = await frames.take((value): value is WsData => value.type === "ws.data");
    expect(relayFrame.binary).toBe(true);
    expect(Buffer.from(relayFrame.data, "base64")).toEqual(Buffer.from([1, 2, 3]));

    const received = waitForMessage(socket);
    handle?.sendData(dataFrame({ bytes: Buffer.from([4, 5, 6]), binary: true }));

    expect(await received).toEqual(Buffer.from([4, 5, 6]));
    handle?.dispose();
  });

  test("passes websocket subprotocols separately from forwarded headers", async () => {
    let forwardedHeader: string | string[] | undefined;
    let protocolHeader: string | string[] | undefined;
    const server = await listenWebSocketServer({
      handleProtocols: (protocols) => (protocols.has("proto-b") ? "proto-b" : false),
    });
    const connection = waitForConnection(server, (_socket, request) => {
      forwardedHeader = request.headers["x-test"];
      protocolHeader = request.headers["sec-websocket-protocol"];
    });

    const handle = openLocalWebSocket(
      openFrame({
        headers: [
          ["sec-websocket-protocol", "proto-a, proto-b"],
          ["x-test", "ok"],
        ],
      }),
      target(server),
      () => {},
    );

    const socket = await connection;
    expect(forwardedHeader).toBe("ok");
    expect(protocolHeader).toContain("proto-a");
    expect(protocolHeader).toContain("proto-b");
    expect(socket.protocol).toBe("proto-b");
    handle?.dispose();
  });

  test("emits a relay close frame when the local socket closes", async () => {
    const server = await listenWebSocketServer();
    const frames = new RelayFrameRecorder();
    const handle = openLocalWebSocket(openFrame(), target(server), (frame) => frames.push(frame));

    const socket = await waitForConnection(server);
    socket.close(4001, "done");

    const close = await frames.take((value): value is WsClose => value.type === "ws.close");
    expect(close.connId).toBe("conn_test");
    expect(close.browserOutTopic).toBe("browser-out");
    expect(close.code).toBe(4001);
    expect(close.reason).toBe("done");
    handle?.dispose();
  });

  test("does not echo a relay close when the browser side closes", async () => {
    const server = await listenWebSocketServer();
    const frames = new RelayFrameRecorder();
    const handle = openLocalWebSocket(openFrame(), target(server), (frame) => frames.push(frame));

    await waitForConnection(server);
    handle?.close(closeFrame({ code: 1000, reason: "browser closed" }));
    await delay(50);

    expect(frames.values.filter((frame) => frame.type === "ws.close")).toEqual([]);
  });

  test("rejects invalid request paths without opening a local socket", async () => {
    const server = await listenWebSocketServer();
    const frames = new RelayFrameRecorder();

    const handle = openLocalWebSocket(openFrame({ path: "not-origin-form" }), target(server), (frame) =>
      frames.push(frame),
    );

    expect(handle).toBeUndefined();
    expect(frames.values).toContainEqual(
      expect.objectContaining({
        type: "ws.close",
        connId: "conn_test",
        browserOutTopic: "browser-out",
        code: 1008,
      }),
    );
  });
});

class RelayFrameRecorder {
  readonly values: Array<WsData | WsClose> = [];
  private readonly waiters: Array<{
    readonly predicate: (frame: WsData | WsClose) => boolean;
    readonly resolve: (frame: WsData | WsClose) => void;
  }> = [];

  push(frame: WsData | WsClose): void {
    this.values.push(frame);
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex === -1) {
      return;
    }

    const [waiter] = this.waiters.splice(waiterIndex, 1);
    waiter?.resolve(frame);
  }

  take<A extends WsData | WsClose>(predicate: (frame: WsData | WsClose) => frame is A): Promise<A> {
    const existing = this.values.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return withTimeout(
      new Promise<A>((resolve) => {
        this.waiters.push({
          predicate,
          resolve: (frame) => resolve(frame as A),
        });
      }),
    );
  }
}

async function listenWebSocketServer(
  options: ConstructorParameters<typeof WebSocketServer>[0] = {},
): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, ...options });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.close();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function waitForConnection(
  server: WebSocketServer,
  onConnection?: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<WebSocket> {
  return withTimeout(
    new Promise((resolve) => {
      server.once("connection", (socket, request) => {
        onConnection?.(socket, request);
        resolve(socket);
      });
    }),
  );
}

function waitForMessage(socket: WebSocket): Promise<Buffer> {
  return withTimeout(
    new Promise((resolve) => {
      socket.once("message", (data: Buffer) => {
        expect(Buffer.isBuffer(data)).toBe(true);
        resolve(data);
      });
    }),
  );
}

function target(server: WebSocketServer): { readonly protocol: "http"; readonly host: string; readonly port: number } {
  return { protocol: "http", host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

function openFrame(options: { readonly path?: string; readonly headers?: WsOpen["headers"] } = {}): WsOpen {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.open",
    frameId: "frm_open",
    connId: "conn_test",
    browserOutTopic: "browser-out",
    localInTopic: "local-in",
    path: options.path ?? "/socket",
    headers: options.headers ?? [],
  };
}

function dataFrame(options: { readonly text?: string; readonly bytes?: Buffer; readonly binary?: boolean }): WsData {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<A>(promise: Promise<A>): Promise<A> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for websocket test event.")), 1_000);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
