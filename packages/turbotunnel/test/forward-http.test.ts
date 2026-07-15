import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { HttpRequest } from "@turbotunnel/contracts";
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

  it.effect("does not expose local host or port when the local request fails", () =>
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
      const body = Buffer.from(response.body, "base64").toString("utf8");

      expect(response.status).toBe(502);
      expect(body).toContain("Tunnel could not reach the local app");
      expect(body).not.toContain("127.0.0.1");
      expect(body).not.toContain(`:${port}`);
    }),
  );
});

function requestFrame(options: {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}): HttpRequest {
  return {
    protocolVersion: 1,
    type: "http.request",
    frameId: "frm_test",
    requestId: "req_test",
    responseTopic: "topic",
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
