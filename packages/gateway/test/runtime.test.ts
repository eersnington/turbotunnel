import { Buffer } from "node:buffer";
import { request as httpRequest, type Server } from "node:http";

import {
  LOCAL_CLIENT_SUBPROTOCOL,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
  type Frame,
  type HttpRequest,
  type WsClose,
  type WsData,
  type WsOpen,
} from "@turbotunnel/contracts";
import { ManagedRuntime, Result } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";

import { GatewayLive, GatewayServer } from "../src/gateway.js";

type RunningGateway = {
  readonly server: Server;
  readonly openLocalClient: (slug: string) => Promise<WebSocket>;
  readonly openPublicWebSocket: (slug: string, path: string) => Promise<WebSocket>;
  readonly dispose: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const running: Array<RunningGateway> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.close()));
});

describe("gateway runtime", () => {
  test("serves status from the scoped gateway server", async () => {
    const gateway = await startGateway();
    const response = await request(gateway.server, {
      path: "/_turbotunnel/status",
      host: "tunnel.test",
      accept: "application/json",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "running",
      baseDomain: "tunnel.test",
      broker: "memory",
      activeLocalClients: 0,
    });
  });

  test("routes direct HTTP and WebSocket traffic through a local client", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("demo");
    const localFrames = new FrameRecorder(local);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_hello",
        slug: "demo",
        localClientId: "local_test",
        sessionId: "session_test",
        generation: 1,
        capacity: 4,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway.server);

    const pendingHttp = request(gateway.server, {
      path: "/hello?name=effect",
      host: "demo.tunnel.test",
      method: "POST",
      body: "request-body",
    });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    expect(forwarded.path).toBe("/hello?name=effect");
    expect(Buffer.from(forwarded.body, "base64").toString("utf8")).toBe("request-body");
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_response",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 201,
        headers: [["x-local-app", "yes"]],
        body: Buffer.from("response-body").toString("base64"),
      }),
    );
    await expect(pendingHttp).resolves.toMatchObject({
      status: 201,
      body: "response-body",
      headers: expect.objectContaining({ "x-local-app": "yes" }),
    });

    const browser = await gateway.openPublicWebSocket("demo", "/socket");
    const open = await localFrames.take((frame): frame is WsOpen => frame.type === "ws.open");
    const browserMessage = waitForMessage(browser);
    browser.send(Buffer.from([1, 2, 3]), { binary: true });
    const browserData = await localFrames.take(
      (frame): frame is WsData => frame.type === "ws.data" && frame.connId === open.connId,
    );
    expect(browserData.binary).toBe(true);
    expect(Buffer.from(browserData.data, "base64")).toEqual(Buffer.from([1, 2, 3]));

    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.data",
        frameId: "frm_local_data",
        connId: open.connId,
        browserOutTopic: open.browserOutTopic,
        seq: 0,
        data: Buffer.from("from-local").toString("base64"),
        binary: false,
      }),
    );
    expect((await browserMessage).toString("utf8")).toBe("from-local");

    browser.close(4000, "browser done");
    const close = await localFrames.take(
      (frame): frame is WsClose => frame.type === "ws.close" && frame.connId === open.connId,
    );
    expect(close).toMatchObject({ code: 4000, reason: "browser done" });
  });

  test("preserves browser WebSocket message order when forwarding to a local client", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("ordered-demo");
    const localFrames = new FrameRecorder(local);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_ordered_hello",
        slug: "ordered-demo",
        localClientId: "local_ordered_test",
        sessionId: "session_ordered_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway.server);

    const browser = await gateway.openPublicWebSocket("ordered-demo", "/ordered");
    const open = await localFrames.take((frame): frame is WsOpen => frame.type === "ws.open");
    const count = 20;
    const received = recordFramesInArrivalOrder(
      local,
      (frame): frame is WsData => frame.type === "ws.data" && frame.connId === open.connId,
      count,
    );
    for (let index = 0; index < count; index += 1) {
      browser.send(`message-${index}`);
    }

    const frames = await received;
    expect(frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    );
    expect(frames.map((frame) => Buffer.from(frame.data, "base64").toString("utf8"))).toEqual(
      Array.from({ length: count }, (_, index) => `message-${index}`),
    );
  });

  test("rejects a valid protocol frame sent before the local-client hello", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("protocol-demo");
    const closed = waitForClose(local);

    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.request",
        frameId: "frm_wrong_direction",
        requestId: "req_wrong_direction",
        responseTopic: "response_wrong_direction",
        method: "GET",
        path: "/",
        headers: [],
        body: "",
      }),
    );

    await expect(closed).resolves.toEqual({ code: 1002, reason: "invalid protocol frame" });
  });

  test("routes queued HTTP and WebSocket traffic across gateway instances", async () => {
    const localGateway = await startGateway();
    const publicGateway = await startGateway();
    const local = await localGateway.openLocalClient("queued-demo");
    const localFrames = new FrameRecorder(local);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_queued_hello",
        slug: "queued-demo",
        localClientId: "local_queued_test",
        sessionId: "session_queued_test",
        generation: 1,
        capacity: 4,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(localGateway.server);

    const pendingHttp = request(publicGateway.server, {
      path: "/queued",
      host: "queued-demo.tunnel.test",
    });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    acknowledge(local, forwarded.frameId);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_queued_response",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 202,
        headers: [],
        body: Buffer.from("queued-response").toString("base64"),
      }),
    );
    await expect(pendingHttp).resolves.toMatchObject({ status: 202, body: "queued-response" });

    const browser = await publicGateway.openPublicWebSocket("queued-demo", "/queued-socket");
    const open = await localFrames.take((frame): frame is WsOpen => frame.type === "ws.open");
    acknowledge(local, open.frameId);
    browser.send("through-queue");
    const inbound = await localFrames.take(
      (frame): frame is WsData => frame.type === "ws.data" && frame.connId === open.connId,
    );
    acknowledge(local, inbound.frameId);
    expect(Buffer.from(inbound.data, "base64").toString("utf8")).toBe("through-queue");

    const browserMessage = waitForMessage(browser);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "ws.data",
        frameId: "frm_queued_local_data",
        connId: open.connId,
        browserOutTopic: open.browserOutTopic,
        seq: 0,
        data: Buffer.from("back-through-queue").toString("base64"),
        binary: false,
      }),
    );
    expect((await browserMessage).toString("utf8")).toBe("back-through-queue");
  }, 10_000);

  test("completes a pending direct request when its local client disconnects", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("disconnect-demo");
    const localFrames = new FrameRecorder(local);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_disconnect_hello",
        slug: "disconnect-demo",
        localClientId: "local_disconnect_test",
        sessionId: "session_disconnect_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway.server);

    const pendingHttp = request(gateway.server, {
      path: "/disconnect",
      host: "disconnect-demo.tunnel.test",
    });
    await localFrames.take((frame): frame is HttpRequest => frame.type === "http.request");
    local.terminate();

    await expect(pendingHttp).resolves.toMatchObject({
      status: 502,
      body: expect.stringContaining("disconnected before the local app responded"),
    });
  });

  test("keeps a newer local-client generation registered when the older socket closes", async () => {
    const gateway = await startGateway();
    const older = await gateway.openLocalClient("generation-demo");
    older.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_generation_1",
        slug: "generation-demo",
        localClientId: "local_generation_test",
        sessionId: "session_generation_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway.server);

    const olderFrames = new FrameRecorder(older);
    const newer = await gateway.openLocalClient("generation-demo");
    const newerFrames = new FrameRecorder(newer);
    await sendText(
      newer,
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_generation_2",
        slug: "generation-demo",
        localClientId: "local_generation_test",
        sessionId: "session_generation_test",
        generation: 2,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );

    const maximumProbeAttempts = 5;
    let probeAttempts = 0;
    let routedToNewer = false;
    while (probeAttempts < maximumProbeAttempts && !routedToNewer) {
      probeAttempts += 1;
      const path = `/generation-probe-${probeAttempts}`;
      const pendingProbe = request(gateway.server, {
        path,
        host: "generation-demo.tunnel.test",
      });
      const predicate = (frame: Frame): frame is HttpRequest =>
        frame.type === "http.request" && frame.path === path;
      const olderTake = olderFrames.takeCancellable(predicate);
      const newerTake = newerFrames.takeCancellable(predicate);
      const routed = await Promise.race([
        olderTake.promise.then((frame) => ({ socket: older, frame, newer: false as const })),
        newerTake.promise.then((frame) => ({ socket: newer, frame, newer: true as const })),
      ]);
      if (routed.newer) {
        olderTake.cancel();
      } else {
        newerTake.cancel();
      }
      routed.socket.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "http.response",
          frameId: `frm_generation_probe_${probeAttempts}_response`,
          requestId: routed.frame.requestId,
          responseTopic: routed.frame.responseTopic,
          status: 200,
          headers: [],
          body: Buffer.from("probe").toString("base64"),
        }),
      );
      await expect(pendingProbe).resolves.toMatchObject({ status: 200, body: "probe" });
      routedToNewer = routed.newer;
    }
    expect(routedToNewer).toBe(true);

    const olderClosed = waitForClose(older);
    older.terminate();
    await olderClosed;
    await waitForActiveLocalClient(gateway.server);

    const pendingHttp = request(gateway.server, {
      path: "/new-generation",
      host: "generation-demo.tunnel.test",
    });
    const forwarded = await newerFrames.take(
      (frame): frame is HttpRequest =>
        frame.type === "http.request" && frame.path === "/new-generation",
    );
    newer.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_generation_response",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 200,
        headers: [],
        body: Buffer.from("newer-client").toString("base64"),
      }),
    );

    await expect(pendingHttp).resolves.toMatchObject({ status: 200, body: "newer-client" });
    const status = await request(gateway.server, {
      path: "/_turbotunnel/status",
      host: "tunnel.test",
      accept: "application/json",
    });
    expect(JSON.parse(status.body)).toMatchObject({
      directHttpRequests: probeAttempts + 1,
      queuedHttpRequests: 0,
    });
  });

  test("suppresses duplicate local WebSocket frames and closes on a sequence gap", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("sequence-demo");
    const localFrames = new FrameRecorder(local);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_sequence_hello",
        slug: "sequence-demo",
        localClientId: "local_sequence_test",
        sessionId: "session_sequence_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway.server);

    const browser = await gateway.openPublicWebSocket("sequence-demo", "/sequence");
    const open = await localFrames.take((frame): frame is WsOpen => frame.type === "ws.open");
    const firstMessage = waitForMessage(browser);
    local.send(localWsData(open, "frm_sequence_0", 0, "first"));
    expect((await firstMessage).toString("utf8")).toBe("first");

    local.send(localWsData(open, "frm_sequence_duplicate", 0, "duplicate"));
    const nextMessage = waitForMessage(browser);
    local.send(localWsData(open, "frm_sequence_1", 1, "second"));
    expect((await nextMessage).toString("utf8")).toBe("second");

    const closed = waitForClose(browser);
    local.send(localWsData(open, "frm_sequence_gap", 3, "gap"));
    await expect(closed).resolves.toEqual({ code: 1011, reason: "websocket queue sequence gap" });
  });

  test("disposes the scoped server while a local WebSocket remains connected", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("shutdown-demo");
    const closed = waitForClose(local);

    await gateway.dispose();

    await closed;
    expect(gateway.server.listening).toBe(false);
  });
});

type HttpResponseResult = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
};

type RequestInput = {
  readonly path: string;
  readonly host: string;
  readonly method?: string;
  readonly accept?: string;
  readonly body?: string;
};

function request(server: Server, input: RequestInput): Promise<HttpResponseResult> {
  const port = serverPort(server);
  return withTimeout(
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: input.method ?? "GET",
          path: input.path,
          headers: {
            host: input.host,
            ...(input.accept === undefined ? {} : { accept: input.accept }),
          },
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.once("error", reject);
      request.end(input.body);
    }),
  );
}

class FrameRecorder {
  private readonly frames: Array<Frame> = [];
  private readonly waiters: Array<{
    readonly predicate: (frame: Frame) => boolean;
    readonly resolve: (frame: Frame) => void;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const parsed = parseProtocolFrameJson(data.toString());
      if (Result.isFailure(parsed)) {
        return;
      }
      const frame = parsed.success;
      this.frames.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index === -1) {
        return;
      }
      const waiter = this.waiters.splice(index, 1)[0];
      waiter?.resolve(frame);
    });
  }

  take<A extends Frame>(predicate: (frame: Frame) => frame is A): Promise<A> {
    return this.takeCancellable(predicate).promise;
  }

  takeCancellable<A extends Frame>(
    predicate: (frame: Frame) => frame is A,
  ): {
    readonly promise: Promise<A>;
    readonly cancel: () => void;
  } {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) {
      return { promise: Promise.resolve(existing), cancel: () => undefined };
    }

    let waiter: (typeof this.waiters)[number] | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: (cause: Error) => void = () => undefined;
    const promise = new Promise<Frame>((resolve, reject) => {
      rejectWait = reject;
      waiter = {
        predicate,
        resolve: (frame) => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          resolve(frame);
        },
      };
      this.waiters.push(waiter);
      timeout = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error("Timed out waiting for gateway test operation."));
      }, 2_000);
    }).then((frame) => {
      if (!predicate(frame)) {
        throw new Error("Gateway test frame no longer matched its waiter predicate.");
      }
      return frame;
    });

    return {
      promise,
      cancel: () => {
        if (waiter === undefined || !this.removeWaiter(waiter)) {
          return;
        }
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        rejectWait(new Error("Gateway test frame wait was cancelled."));
      },
    };
  }

  private removeWaiter(waiter: (typeof this.waiters)[number] | undefined): boolean {
    if (waiter === undefined) {
      return false;
    }
    const index = this.waiters.indexOf(waiter);
    if (index === -1) {
      return false;
    }
    this.waiters.splice(index, 1);
    return true;
  }
}

async function startGateway(): Promise<RunningGateway> {
  const runtime = ManagedRuntime.make(
    GatewayLive({
      NODE_ENV: "development",
      TURBOTUNNEL_BASE_DOMAIN: "tunnel.test",
      TURBOTUNNEL_BROKER: "memory",
      TURBOTUNNEL_RELAY_SECRET: "test_secret",
    }),
  );
  const server = await runtime.runPromise(GatewayServer);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const sockets = new Set<WebSocket>();
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };
  const gateway = {
    server,
    openLocalClient: (slug: string) =>
      openSocket(
        server,
        `/${slug}`,
        {
          host: `${slug}.tunnel.test`,
          authorization: "Bearer test_secret",
        },
        LOCAL_CLIENT_SUBPROTOCOL,
      ).then((socket) => {
        sockets.add(socket);
        return socket;
      }),
    openPublicWebSocket: (slug: string, path: string) =>
      openSocket(server, path, { host: `${slug}.tunnel.test` }).then((socket) => {
        sockets.add(socket);
        return socket;
      }),
    dispose,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await dispose();
    },
  };
  running.push(gateway);
  return gateway;
}

function openSocket(
  server: Server,
  path: string,
  headers: Readonly<Record<string, string>>,
  protocol?: string,
): Promise<WebSocket> {
  const port = serverPort(server);
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${path}`,
    protocol === undefined ? undefined : protocol,
    { headers },
  );
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    }),
  );
}

async function waitForActiveLocalClient(server: Server): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request(server, {
      path: "/_turbotunnel/status",
      host: "tunnel.test",
      accept: "application/json",
    });
    const body: unknown = JSON.parse(response.body);
    if (
      typeof body === "object" &&
      body !== null &&
      "activeLocalClients" in body &&
      body.activeLocalClients === 1
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local client did not register with the gateway.");
}

function waitForMessage(socket: WebSocket): Promise<Buffer> {
  return withTimeout(
    new Promise((resolve) => {
      socket.once("message", (data) => {
        if (Buffer.isBuffer(data)) {
          resolve(data);
          return;
        }
        if (data instanceof ArrayBuffer) {
          resolve(Buffer.from(data));
          return;
        }
        resolve(Buffer.concat(data));
      });
    }),
  );
}

function recordFramesInArrivalOrder<A extends Frame>(
  socket: WebSocket,
  predicate: (frame: Frame) => frame is A,
  count: number,
): Promise<ReadonlyArray<A>> {
  return withTimeout(
    new Promise((resolve) => {
      const frames: Array<A> = [];
      const onMessage = (data: RawData): void => {
        const parsed = parseProtocolFrameJson(data.toString());
        if (Result.isFailure(parsed) || !predicate(parsed.success)) {
          return;
        }
        frames.push(parsed.success);
        if (frames.length === count) {
          socket.removeListener("message", onMessage);
          resolve(frames);
        }
      };
      socket.on("message", onMessage);
    }),
  );
}

function waitForClose(
  socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
  return withTimeout(
    new Promise((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    }),
  );
}

function localWsData(open: WsOpen, frameId: string, seq: number, body: string): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.data",
    frameId,
    connId: open.connId,
    browserOutTopic: open.browserOutTopic,
    seq,
    data: Buffer.from(body).toString("base64"),
    binary: false,
  });
}

function acknowledge(socket: WebSocket, frameId: string): void {
  socket.send(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: "delivery.ack",
      frameId: `ack_${frameId}`,
      ackFrameId: frameId,
    }),
  );
}

function sendText(socket: WebSocket, text: string): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.send(text, (cause) => {
        if (cause === undefined || cause === null) {
          resolve();
          return;
        }
        reject(cause);
      });
    }),
  );
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Gateway test server is not listening on a TCP port.");
  }
  return address.port;
}

function withTimeout<A>(promise: Promise<A>, timeoutMs = 2_000): Promise<A> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Timed out waiting for gateway test operation.")),
        timeoutMs,
      );
    }),
  ]);
}
