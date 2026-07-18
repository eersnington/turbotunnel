import { Buffer } from "node:buffer";
import { randomBytes, scryptSync } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";

import {
  ACCESS_SCRYPT_N,
  ACCESS_SCRYPT_P,
  ACCESS_SCRYPT_R,
  LOCAL_CLIENT_SUBPROTOCOL,
  PRESENCE_TOPIC,
  requestTopic,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
  tunnelListResponseSchema,
  tunnelPresenceEventSchema,
  type TunnelPresenceEvent,
  type AccessPolicy,
  type Frame,
  type HttpRequest,
  type WsClose,
  type WsData,
  type WsOpen,
} from "@turbotunnel/contracts";
import { Effect, ManagedRuntime, Result, Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";

import { GatewayLive, GatewayServer, VercelGatewayLive } from "../src/gateway.js";
import { Queue } from "../src/queue.js";
import { PublicRouteRegistry } from "../src/public-route-registry.js";

type RunningGateway = {
  readonly server: Server;
  readonly queue: Queue["Service"];
  readonly routes: PublicRouteRegistry["Service"];
  readonly openLocalClient: (slug: string, host?: string) => Promise<WebSocket>;
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
    expect(response.headers["content-type"]).toContain("application/json");

    const landing = await request(gateway.server, {
      path: "/",
      host: "tunnel.test",
    });
    expect(landing.status).toBe(200);
    expect(landing.headers["content-type"]).toContain("text/plain");
  });

  test("does not let a public request replace the token used by Vercel Queue", async () => {
    const originalFetch = globalThis.fetch;
    const authorizationHeaders: Array<string | null> = [];
    globalThis.fetch = async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      const url = String(input);
      return new Response(null, { status: url.includes("/consumer/") ? 204 : 201 });
    };

    try {
      const gateway = await startGateway({
        TURBOTUNNEL_BROKER: "vercel",
        VERCEL_OIDC_TOKEN: "trusted-process-token",
      });
      const response = await request(gateway.server, {
        path: "/_turbotunnel/status",
        host: "tunnel.test",
        headers: { "x-vercel-oidc-token": "attacker-token" },
      });

      expect(response.status).toBe(200);
      authorizationHeaders.length = 0;
      await Effect.runPromise(gateway.queue.send("authority-test", { ok: true }));
      expect(authorizationHeaders).toEqual(["Bearer trusted-process-token"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lets the Vercel adapter refresh the token used by Vercel Queue", async () => {
    const originalFetch = globalThis.fetch;
    const authorizationHeaders: Array<string | null> = [];
    globalThis.fetch = async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return new Response(null, { status: 201 });
    };

    try {
      const gateway = await startGateway(
        {
          TURBOTUNNEL_BROKER: "vercel",
          VERCEL_OIDC_TOKEN: "initial-token",
        },
        "vercel",
      );
      const response = await request(gateway.server, {
        path: "/_turbotunnel/status",
        host: "tunnel.test",
        headers: { "x-vercel-oidc-token": "invocation-token" },
      });

      expect(response.status).toBe(200);
      authorizationHeaders.length = 0;
      await Effect.runPromise(gateway.queue.send("authority-test", { ok: true }));
      expect(authorizationHeaders).toEqual(["Bearer invocation-token"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects hosts outside the configured tunnel domain", async () => {
    const gateway = await startGateway();

    const wrongDomain = await request(gateway.server, {
      path: "/",
      host: "demo.other.test",
    });
    const invalidSlug = await request(gateway.server, {
      path: "/",
      host: "bad_slug.tunnel.test",
    });

    expect(wrongDomain.status).toBe(404);
    expect(invalidSlug.status).toBe(404);
  });

  test("authenticates the exact tunnel-list route with the relay secret", async () => {
    const gateway = await startGateway();
    const missing = await request(gateway.server, {
      path: "/_turbotunnel/tunnels",
      host: "tunnel.test",
    });
    const wrong = await request(gateway.server, {
      path: "/_turbotunnel/tunnels",
      host: "tunnel.test",
      authorization: "Bearer wrong_secret",
    });
    const valid = await request(gateway.server, {
      path: "/_turbotunnel/tunnels",
      host: "tunnel.test",
      authorization: "Bearer test_secret",
    });
    const query = await request(gateway.server, {
      path: "/_turbotunnel/tunnels?unexpected=true",
      host: "tunnel.test",
      authorization: "Bearer test_secret",
      accept: "application/json",
    });
    const post = await request(gateway.server, {
      path: "/_turbotunnel/tunnels?unexpected=true",
      host: "tunnel.test",
      authorization: "Bearer test_secret",
      accept: "application/json",
      method: "POST",
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(tunnelListResponseSchema)(JSON.parse(valid.body) as unknown),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(tunnelListResponseSchema)(JSON.parse(query.body) as unknown),
      ),
    ).toBe(true);
    expect(JSON.parse(post.body)).toMatchObject({ status: "running" });
  });

  test("lists a shared in-memory relay pool across instances and removes disconnects", async () => {
    const firstGateway = await startGateway();
    const secondGateway = await startGateway();
    const listingGateway = await startGateway();
    const first = await firstGateway.openLocalClient("presence-runtime");
    const second = await secondGateway.openLocalClient("presence-runtime");
    sendHello(first, {
      slug: "presence-runtime",
      localClientId: "presence_client_a",
      sessionId: "presence_session",
      generation: 1,
      connectedAt: 1_234,
    });
    sendHello(second, {
      slug: "presence-runtime",
      localClientId: "presence_client_b",
      sessionId: "presence_session",
      generation: 1,
      connectedAt: 1_234,
    });
    await Promise.all([
      waitForActiveLocalClient(firstGateway),
      waitForActiveLocalClient(secondGateway),
    ]);

    const pooled = await waitForListedTunnel(listingGateway.server, "presence-runtime", 2);
    expect(pooled).toMatchObject({
      sessionId: "presence_session",
      relayCount: 2,
      connectedAt: 1_234,
      target: { protocol: "http", host: "127.0.0.1", port: 4321 },
    });

    second.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.heartbeat",
        frameId: "presence_heartbeat",
        slug: "presence-runtime",
        localClientId: "presence_client_b",
        sessionId: "presence_session",
        generation: 1,
        lastSeen: Date.now(),
      }),
    );
    const events = await receivePresenceEvents(listingGateway.queue, "runtime_heartbeat_consumer");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "refresh",
        slug: "presence-runtime",
        localClientId: "presence_client_b",
        sequence: 2,
      }),
    );

    const closed = waitForClose(first);
    first.close(1000, "local shutdown");
    await closed;
    const remaining = await waitForListedTunnel(listingGateway.server, "presence-runtime", 1);
    expect(remaining.relayCount).toBe(1);
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
        publicHost: "demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_test",
        sessionId: "session_test",
        generation: 1,
        capacity: 4,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway, "demo.tunnel.test");

    const pendingHttp = request(gateway.server, {
      path: "/hello?name=effect",
      host: "demo.tunnel.test",
      method: "POST",
      body: "request-body",
      headers: {
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "x-custom": "preserved",
        "x-forwarded-host": "attacker.test",
        "x-forwarded-proto": "http",
        "x-turbotunnel-request-id": "attacker-controlled",
      },
    });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    expect(forwarded.path).toBe("/hello?name=effect");
    expect(Buffer.from(forwarded.body, "base64").toString("utf8")).toBe("request-body");
    expect(headerValues(forwarded.headers, "x-custom")).toEqual(["preserved"]);
    expect(headerValues(forwarded.headers, "connection")).toEqual([]);
    expect(headerValues(forwarded.headers, "keep-alive")).toEqual([]);
    expect(headerValues(forwarded.headers, "host")).toEqual(["127.0.0.1:4321"]);
    expect(headerValues(forwarded.headers, "x-forwarded-host")).toEqual(["demo.tunnel.test"]);
    expect(headerValues(forwarded.headers, "x-forwarded-proto")).toEqual(["http"]);
    expect(headerValues(forwarded.headers, "x-turbotunnel-request-id")).toEqual([
      forwarded.requestId,
    ]);
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_response",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 201,
        headers: [
          ["x-local-app", "yes"],
          ["set-cookie", "first=1"],
          ["set-cookie", "second=2"],
          ["connection", "close"],
        ],
        body: Buffer.from("response-body").toString("base64"),
      }),
    );
    await expect(pendingHttp).resolves.toMatchObject({
      status: 201,
      body: "response-body",
      headers: expect.objectContaining({ "x-local-app": "yes" }),
    });
    const completedHttp = await pendingHttp;
    expect(completedHttp.headers["set-cookie"]).toEqual(["first=1", "second=2"]);

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

  test("renders recovery guidance when the local app is unavailable", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("offline");
    const localFrames = new FrameRecorder(local);
    sendHello(local, {
      slug: "offline",
      localClientId: "local_offline",
      sessionId: "session_offline",
      generation: 1,
    });
    await waitForActiveLocalClient(gateway, "offline.tunnel.test");

    const pending = request(gateway.server, {
      path: "/dashboard",
      host: "offline.tunnel.test",
    });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_unavailable",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 502,
        headers: [],
        body: "",
        tunnelError: "local-app-unavailable",
      }),
    );

    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Local app unavailable");
    expect(response.body).toContain("tt http");
    expect(response.body).toContain("--host");
    expect(response.body).toContain("https://turbotunnel.eers.dev/docs");
    expect(response.body).not.toContain("127.0.0.1");
    expect(response.body).not.toContain("4321");
  });

  test("routes a registered exact public host outside the relay base domain", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("exact-demo", "preview.example.test");
    const localFrames = new FrameRecorder(local);
    sendHello(local, {
      slug: "exact-demo",
      publicHost: "preview.example.test",
      localClientId: "exact_client",
      sessionId: "exact_session",
      generation: 1,
    });
    await waitForActiveLocalClient(gateway, "preview.example.test");

    let mismatchedForwarded = false;
    local.on("message", (data) => {
      const frame = parseProtocolFrameJson(data.toString());
      if (Result.isSuccess(frame) && frame.success.type === "http.request") {
        mismatchedForwarded ||= frame.success.path === "/wrong-route";
      }
    });
    await Effect.runPromise(
      gateway.queue.send(requestTopic("exact-demo"), {
        protocolVersion: PROTOCOL_VERSION,
        type: "http.request",
        frameId: "wrong_route_frame",
        requestId: "wrong_route_request",
        responseTopic: "wrong_route_response",
        routeIdentity: {
          publicHost: "other.example.test",
          policyFingerprint: "policy-v1:public",
          sessionId: "exact_session",
        },
        method: "GET",
        path: "/wrong-route",
        headers: [],
        body: "",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mismatchedForwarded).toBe(false);

    const pending = request(gateway.server, { path: "/exact", host: "PREVIEW.example.test:443" });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    expect(forwarded.routeIdentity).toEqual({
      publicHost: "preview.example.test",
      policyFingerprint: "policy-v1:public",
      sessionId: "exact_session",
    });
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "exact_response",
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 200,
        headers: [],
        body: Buffer.from("exact-host").toString("base64"),
      }),
    );

    await expect(pending).resolves.toMatchObject({ status: 200, body: "exact-host" });
  });

  test("denies HTTP before forwarding or allocating tunnel work", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("private-http");
    let forwarded = false;
    local.on("message", (data) => {
      const frame = parseProtocolFrameJson(data.toString());
      if (Result.isSuccess(frame) && frame.success.type === "http.request") forwarded = true;
    });
    sendHello(local, {
      slug: "private-http",
      accessPolicy: { type: "ipAllowlist", cidrs: ["203.0.113.0/24"] },
      localClientId: "private_http_client",
      sessionId: "private_http_session",
      generation: 1,
    });
    await waitForActiveLocalClient(gateway, "private-http.tunnel.test");

    const denied = await request(gateway.server, {
      path: "/denied",
      host: "private-http.tunnel.test",
      method: "POST",
      body: "must-not-be-read-or-forwarded",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(denied.status).toBe(403);
    const protectedStatus = await request(gateway.server, {
      path: "/_turbotunnel/status",
      host: "private-http.tunnel.test",
    });
    expect(protectedStatus.status).toBe(200);
    expect(forwarded).toBe(false);
  });

  test("denies WebSocket access before sending 101 or creating tunnel state", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("private-ws");
    let forwarded = false;
    local.on("message", (data) => {
      const frame = parseProtocolFrameJson(data.toString());
      if (Result.isSuccess(frame) && frame.success.type === "ws.open") forwarded = true;
    });
    sendHello(local, {
      slug: "private-ws",
      accessPolicy: {
        type: "password",
        hash: encodeTestPasswordHash("private-ws-secret"),
      },
      localClientId: "private_ws_client",
      sessionId: "private_ws_session",
      generation: 1,
    });
    await waitForActiveLocalClient(gateway, "private-ws.tunnel.test");

    const status = await rejectedWebSocketStatus(
      gateway.server,
      "private-ws.tunnel.test",
      "/socket",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(status).toBe(401);
    expect(forwarded).toBe(false);
  });

  test("rejects unsupported public WebSocket subprotocols before sending 101", async () => {
    const gateway = await startGateway();

    const status = await rejectedWebSocketStatus(
      gateway.server,
      "subprotocol-demo.tunnel.test",
      "/socket",
      "graphql-ws",
    );

    expect(status).toBe(400);
  });

  test("password login sets a cookie that admits subsequent HTTP", async () => {
    const gateway = await startGateway();
    const local = await gateway.openLocalClient("login-demo");
    const localFrames = new FrameRecorder(local);
    const secret = "login-demo-secret";
    const hash = encodeTestPasswordHash(secret);
    sendHello(local, {
      slug: "login-demo",
      accessPolicy: { type: "password", hash },
      localClientId: "login_demo_client",
      sessionId: "login_demo_session",
      generation: 1,
    });
    await waitForActiveLocalClient(gateway, "login-demo.tunnel.test");

    const denied = await request(gateway.server, {
      path: "/",
      host: "login-demo.tunnel.test",
    });
    expect(denied.status).toBe(303);
    expect(denied.headers.location).toBe("/_turbotunnel/login");

    const loginGet = await request(gateway.server, {
      path: "/_turbotunnel/login",
      host: "login-demo.tunnel.test",
    });
    expect(loginGet.status).toBe(200);
    expect(loginGet.headers["content-type"]).toContain("text/html");
    expect(loginGet.body).toContain("Password required");
    expect(loginGet.body).toContain('name="password"');
    expect(loginGet.body).toContain("https://turbotunnel.eers.dev/docs");

    const wrong = await request(gateway.server, {
      path: "/_turbotunnel/login",
      host: "login-demo.tunnel.test",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["content-type"]).toContain("text/html");
    expect(wrong.body).toContain("Password was not accepted.");
    expect(wrong.body).toContain('name="password"');

    const login = await request(gateway.server, {
      path: "/_turbotunnel/login",
      host: "login-demo.tunnel.test",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(secret)}`,
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    const cookiePair = cookieHeader!.split(";", 1)[0]!;

    const pending = request(gateway.server, {
      path: "/",
      host: "login-demo.tunnel.test",
      headers: { cookie: cookiePair },
    });
    const forwarded = await localFrames.take(
      (frame): frame is HttpRequest => frame.type === "http.request",
    );
    local.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: `resp_${forwarded.requestId}`,
        requestId: forwarded.requestId,
        responseTopic: forwarded.responseTopic,
        status: 200,
        headers: [["content-type", "text/plain"]],
        body: Buffer.from("authed").toString("base64"),
      }),
    );
    await expect(pending).resolves.toMatchObject({ status: 200, body: "authed" });
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
        publicHost: "ordered-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_ordered_test",
        sessionId: "session_ordered_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway, "ordered-demo.tunnel.test");

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
        publicHost: "queued-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_queued_test",
        sessionId: "session_queued_test",
        generation: 1,
        capacity: 4,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(localGateway, "queued-demo.tunnel.test");
    await waitForPublicRoute(publicGateway, "queued-demo.tunnel.test");

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
        publicHost: "disconnect-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_disconnect_test",
        sessionId: "session_disconnect_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway, "disconnect-demo.tunnel.test");

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

  test("hands new work to a newer generation while the older generation completes owned work", async () => {
    const gateway = await startGateway();
    const older = await gateway.openLocalClient("generation-demo");
    const olderFrames = new FrameRecorder(older);
    older.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_generation_1",
        slug: "generation-demo",
        publicHost: "generation-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_generation_test",
        sessionId: "session_generation_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway, "generation-demo.tunnel.test");

    const olderRequest = request(gateway.server, {
      path: "/owned-by-generation-1",
      host: "generation-demo.tunnel.test",
    });
    const owned = await olderFrames.take(
      (frame): frame is HttpRequest =>
        frame.type === "http.request" && frame.path === "/owned-by-generation-1",
    );

    const newer = await gateway.openLocalClient("generation-demo");
    const newerFrames = new FrameRecorder(newer);
    await sendText(
      newer,
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "local.hello",
        frameId: "frm_generation_2",
        slug: "generation-demo",
        publicHost: "generation-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_generation_test",
        sessionId: "session_generation_test",
        generation: 2,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );

    await newerFrames.take((frame): frame is Frame => frame.type === "local.ready");

    older.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "http.response",
        frameId: "frm_generation_1_response",
        requestId: owned.requestId,
        responseTopic: owned.responseTopic,
        status: 200,
        headers: [],
        body: Buffer.from("older-client").toString("base64"),
      }),
    );
    await expect(olderRequest).resolves.toMatchObject({ status: 200, body: "older-client" });

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
      directHttpRequests: 2,
      queuedHttpRequests: 0,
    });
  });

  test("rejects generation 1 arriving after generation 2 for the same session and client", async () => {
    const gateway = await startGateway();
    const newer = await gateway.openLocalClient("reordered-generation");
    const newerFrames = new FrameRecorder(newer);
    sendHello(newer, {
      slug: "reordered-generation",
      localClientId: "local_reordered",
      sessionId: "session_reordered",
      generation: 2,
    });
    await newerFrames.take((frame): frame is Frame => frame.type === "local.ready");

    const stale = await gateway.openLocalClient("reordered-generation");
    const staleClosed = waitForClose(stale);
    sendHello(stale, {
      slug: "reordered-generation",
      localClientId: "local_reordered",
      sessionId: "session_reordered",
      generation: 1,
    });
    await expect(staleClosed).resolves.toEqual({
      code: 1008,
      reason: "stale local client generation",
    });

    const status = await request(gateway.server, {
      path: "/_turbotunnel/status",
      host: "tunnel.test",
      accept: "application/json",
    });
    expect(JSON.parse(status.body)).toMatchObject({ activeLocalClients: 1 });
    expect(newer.readyState).toBe(WebSocket.OPEN);
  });

  test("rejects a duplicate generation while keeping the existing client active", async () => {
    const gateway = await startGateway();
    const existing = await gateway.openLocalClient("duplicate-generation");
    const existingFrames = new FrameRecorder(existing);
    sendHello(existing, {
      slug: "duplicate-generation",
      localClientId: "local_duplicate",
      sessionId: "session_duplicate",
      generation: 1,
    });
    await existingFrames.take((frame): frame is Frame => frame.type === "local.ready");

    const duplicate = await gateway.openLocalClient("duplicate-generation");
    const duplicateClosed = waitForClose(duplicate);
    sendHello(duplicate, {
      slug: "duplicate-generation",
      localClientId: "local_duplicate",
      sessionId: "session_duplicate",
      generation: 1,
    });
    await expect(duplicateClosed).resolves.toEqual({
      code: 1008,
      reason: "stale local client generation",
    });

    const status = await request(gateway.server, {
      path: "/_turbotunnel/status",
      host: "tunnel.test",
      accept: "application/json",
    });
    expect(JSON.parse(status.body)).toMatchObject({ activeLocalClients: 1 });
    expect(existing.readyState).toBe(WebSocket.OPEN);
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
        publicHost: "sequence-demo.tunnel.test",
        accessPolicy: { type: "public" },
        localClientId: "local_sequence_test",
        sessionId: "session_sequence_test",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 4321 },
      }),
    );
    await waitForActiveLocalClient(gateway, "sequence-demo.tunnel.test");

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
  readonly authorization?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
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
            ...input.headers,
            host: input.host,
            ...(input.accept === undefined ? {} : { accept: input.accept }),
            ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
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

function headerValues(headers: HttpRequest["headers"], name: string): ReadonlyArray<string> {
  return headers.filter(([header]) => header === name).map(([, value]) => value);
}

function encodeTestPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, {
    N: ACCESS_SCRYPT_N,
    r: ACCESS_SCRYPT_R,
    p: ACCESS_SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$1$${ACCESS_SCRYPT_N}$${ACCESS_SCRYPT_R}$${ACCESS_SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function sendHello(
  socket: WebSocket,
  input: {
    readonly slug: string;
    readonly publicHost?: string;
    readonly accessPolicy?: AccessPolicy;
    readonly localClientId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly connectedAt?: number;
  },
): void {
  socket.send(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: "local.hello",
      frameId: `hello_${input.localClientId}_${input.generation}`,
      ...input,
      publicHost: input.publicHost ?? `${input.slug}.tunnel.test`,
      accessPolicy: input.accessPolicy ?? { type: "public" },
      capacity: 4,
      target: { protocol: "http", host: "127.0.0.1", port: 4321 },
    }),
  );
}

async function waitForListedTunnel(server: Server, slug: string, relayCount: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(server, {
      path: "/_turbotunnel/tunnels",
      host: "tunnel.test",
      authorization: "Bearer test_secret",
    });
    const decoded = Schema.decodeUnknownResult(tunnelListResponseSchema)(
      JSON.parse(response.body) as unknown,
    );
    if (Result.isSuccess(decoded)) {
      const tunnel = decoded.success.tunnels.find((candidate) => candidate.slug === slug);
      if (tunnel?.relayCount === relayCount) {
        return tunnel;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Tunnel ${slug} did not reach relay count ${relayCount}.`);
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

async function startGateway(
  env: NodeJS.ProcessEnv = {},
  platform: "generic" | "vercel" = "generic",
): Promise<RunningGateway> {
  const makeGateway = platform === "vercel" ? VercelGatewayLive : GatewayLive;
  const runtime = ManagedRuntime.make(
    makeGateway({
      NODE_ENV: "development",
      TURBOTUNNEL_BASE_DOMAIN: "tunnel.test",
      TURBOTUNNEL_BROKER: "memory",
      TURBOTUNNEL_RELAY_SECRET: "test_secret",
      ...env,
    }),
  );
  const server = await runtime.runPromise(GatewayServer);
  const queue = await runtime.runPromise(Queue);
  const routes = await runtime.runPromise(PublicRouteRegistry);
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
    queue,
    routes,
    openLocalClient: (slug: string, host = `${slug}.tunnel.test`) =>
      openSocket(
        server,
        `/${slug}`,
        {
          host,
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

async function receivePresenceEvents(
  queue: Queue["Service"],
  consumerGroup: string,
): Promise<ReadonlyArray<TunnelPresenceEvent>> {
  const events: Array<TunnelPresenceEvent> = [];
  for (let emptyAttempts = 0; emptyAttempts < 20;) {
    const messages = await Effect.runPromise(
      queue.receive({
        topic: PRESENCE_TOPIC,
        consumerGroup,
        limit: 10,
        visibilityTimeoutSeconds: 30,
      }),
    );
    if (messages.length === 0) {
      emptyAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    emptyAttempts = 0;
    for (const message of messages) {
      const decoded = Schema.decodeUnknownResult(tunnelPresenceEventSchema, {
        onExcessProperty: "error",
      })(message.payload);
      await Effect.runPromise(message.ack);
      if (Result.isSuccess(decoded)) {
        events.push(decoded.success);
      }
    }
  }
  return events;
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

function rejectedWebSocketStatus(
  server: Server,
  host: string,
  path: string,
  protocol?: string,
): Promise<number> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${serverPort(server)}${path}`,
    protocol === undefined ? undefined : protocol,
    { headers: { host } },
  );
  socket.on("error", () => undefined);
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once("open", () => reject(new Error("WebSocket unexpectedly received 101.")));
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      });
    }),
  );
}

async function waitForActiveLocalClient(
  gateway: RunningGateway,
  publicHost?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request(gateway.server, {
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
      if (publicHost !== undefined) await waitForPublicRoute(gateway, publicHost);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local client did not register with the gateway.");
}

async function waitForPublicRoute(gateway: RunningGateway, publicHost: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await Effect.runPromise(gateway.routes.lookup(publicHost));
    if (result._tag === "Found") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Public route ${publicHost} did not become ready.`);
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
