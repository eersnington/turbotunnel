import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { PROTOCOL_VERSION, type HttpRequest } from "@turbotunnel/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { forwardHttpToLocalApp } from "../src/runtime/forward-http.js";

describe("forwardHttpToLocalApp", () => {
  it.effect("forwards method, body, and response through a real local server", () =>
    Effect.gen(function* () {
      const received: Array<{ readonly method: string | undefined; readonly body: string }> = [];
      const server = yield* listenScoped(
        createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            received.push({ method: request.method, body: Buffer.concat(chunks).toString("utf8") });
            response.writeHead(201, {
              "content-type": "text/plain",
              "content-length": "7",
              "x-test": "ok",
            });
            response.end("created");
          });
        }),
      );
      const port = (server.address() as AddressInfo).port;
      const response = yield* forwardHttpToLocalApp(
        requestFrame({ method: "POST", path: "/submit", body: "hello" }),
        {
          protocol: "http",
          host: "127.0.0.1",
          port,
        },
      );

      expect(response.status).toBe(201);
      expect(Buffer.from(response.body, "base64").toString("utf8")).toBe("created");
      expect(response.headers).toContainEqual(["content-type", "text/plain"]);
      expect(response.headers).toContainEqual(["x-test", "ok"]);
      expect(response.headers.some(([name]) => name.toLowerCase() === "content-length")).toBe(
        false,
      );
      expect(received).toEqual([{ method: "POST", body: "hello" }]);
    }),
  );

  it.effect("marks local reachability failures for the gateway", () =>
    Effect.gen(function* () {
      const server = yield* listenScoped(
        createServer((request) => {
          request.socket.destroy();
        }),
      );
      const port = (server.address() as AddressInfo).port;
      const response = yield* forwardHttpToLocalApp(
        requestFrame({ method: "GET", path: "/", body: "" }),
        {
          protocol: "http",
          host: "127.0.0.1",
          port,
        },
      );
      expect(response.status).toBe(502);
      expect(response.tunnelError).toBe("local-app-unavailable");
      expect(response.headers).toEqual([]);
      expect(response.body).toBe("");
    }),
  );

  it.effect("relays redirects without contacting the redirect target", () =>
    Effect.gen(function* () {
      let targetRequests = 0;
      const target = yield* listenScoped(
        createServer((_request, response) => {
          targetRequests += 1;
          response.end("followed");
        }),
      );
      const targetPort = (target.address() as AddressInfo).port;
      const redirect = yield* listenScoped(
        createServer((_request, response) => {
          response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` });
          response.end("redirecting");
        }),
      );
      const redirectPort = (redirect.address() as AddressInfo).port;

      const response = yield* forwardHttpToLocalApp(
        requestFrame({ method: "GET", path: "/redirect", body: "" }),
        { protocol: "http", host: "127.0.0.1", port: redirectPort },
      );

      expect(response.status).toBe(302);
      expect(response.headers).toContainEqual([
        "location",
        `http://127.0.0.1:${targetPort}/target`,
      ]);
      expect(Buffer.from(response.body, "base64").toString("utf8")).toBe("redirecting");
      expect(targetRequests).toBe(0);
    }),
  );
});

function requestFrame(options: {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}): HttpRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "http.request",
    frameId: "frm_test",
    requestId: "req_test",
    responseTopic: "topic",
    routeIdentity: {
      publicHost: "demo.test",
      policyFingerprint: "policy-v1:public",
      sessionId: "session_test",
    },
    deadlineAt: Date.now() + 1_000,
    method: options.method,
    path: options.path,
    headers: [],
    body: Buffer.from(options.body, "utf8").toString("base64"),
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function listenScoped(server: ReturnType<typeof createServer>) {
  return Effect.acquireRelease(
    Effect.promise(() => listen(server)).pipe(Effect.as(server)),
    (server) => Effect.promise(() => close(server)).pipe(Effect.orDie),
  );
}
