import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { HttpRequest } from "@turbotunnel/contracts";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { forwardHttpToLocalApp } from "../src/runtime/forward-http.js";

describe("forwardHttpToLocalApp", () => {
  test("forwards method, body, and response through a real local server", async () => {
    const received: Array<{ readonly method: string | undefined; readonly body: string }> = [];
    const server = createServer((request, response) => {
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
    });
    await listen(server);

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await Effect.runPromise(
        forwardHttpToLocalApp(
          requestFrame({ method: "POST", path: "/submit", body: "hello" }),
          { protocol: "http", host: "127.0.0.1", port },
        ),
      );

      expect(response.status).toBe(201);
      expect(Buffer.from(response.body, "base64").toString("utf8")).toBe("created");
      expect(response.headers).toContainEqual(["content-type", "text/plain"]);
      expect(response.headers).toContainEqual(["x-test", "ok"]);
      expect(response.headers.some(([name]) => name.toLowerCase() === "content-length")).toBe(false);
      expect(received).toEqual([{ method: "POST", body: "hello" }]);
    } finally {
      await close(server);
    }
  });

  test("does not expose local host or port when the local request fails", async () => {
    const server = createServer((request) => {
      request.socket.destroy();
    });
    await listen(server);

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await Effect.runPromise(
        forwardHttpToLocalApp(requestFrame({ method: "GET", path: "/", body: "" }), {
          protocol: "http",
          host: "127.0.0.1",
          port,
        }),
      );
      const body = Buffer.from(response.body, "base64").toString("utf8");

      expect(response.status).toBe(502);
      expect(body).toContain("Tunnel could not reach the local app");
      expect(body).not.toContain("127.0.0.1");
      expect(body).not.toContain(`:${port}`);
    } finally {
      await close(server);
    }
  });
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
