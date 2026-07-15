import type { IncomingMessage } from "node:http";

import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { GatewayConfig } from "../src/gateway-config.js";
import { GatewayState } from "../src/gateway-state.js";
import { runPublicWebSocket } from "../src/public-websocket.js";
import { Queue, QueueReceiveError } from "../src/queue.js";
import type { GatewayWebSocket } from "../src/websocket.js";

describe("public WebSocket pump ownership", () => {
  test("terminates the browser connection when its output pump fails", async () => {
    const closes: Array<{
      readonly code: number | undefined;
      readonly reason: string | undefined;
    }> = [];
    const socket: GatewayWebSocket = {
      receive: Effect.never,
      isOpen: Effect.succeed(true),
      sendFrame: () => Effect.succeed(true),
      sendData: () => Effect.succeed(true),
      close: (code, reason) => Effect.sync(() => closes.push({ code, reason })),
    };
    const queue = Queue.of({
      send: () => Effect.void,
      receive: (options) =>
        Effect.fail(
          new QueueReceiveError({
            operation: "test receive",
            topic: options.topic,
            message: "The test queue failed while pumping browser output.",
            cause: new Error("queue unavailable"),
          }),
        ),
    });
    const request = {
      url: "/socket",
      rawHeaders: ["host", "demo.tunnel.test"],
    } as IncomingMessage;
    const layer = Layer.mergeAll(
      Layer.succeed(
        GatewayConfig,
        GatewayConfig.of({
          baseDomain: "tunnel.test",
          relaySecret: Redacted.make("test"),
          queueRegion: "iad1",
          brokerKind: "memory",
          port: 3002,
        }),
      ),
      GatewayState.layer,
      Layer.succeed(Queue, queue),
    );

    await Effect.runPromise(
      runPublicWebSocket(socket, request, {
        host: "demo.tunnel.test",
        authorization: undefined,
        forwardedProto: "http",
        oidcToken: undefined,
        secWebSocketProtocols: [],
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    expect(closes).toEqual([{ code: 1011, reason: "gateway queue operation failed" }]);
  });
});
