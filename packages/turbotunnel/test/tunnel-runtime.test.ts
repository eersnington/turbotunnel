import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { NodeServices } from "@effect/platform-node";
import {
  LOCAL_CLIENT_SUBPROTOCOL,
  parseProtocolFrameJson,
  type LocalClientHello,
} from "@turbotunnel/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import { WebSocketServer, type WebSocket } from "ws";

import { LocalControl } from "../src/adapters/local-control.js";
import { RuntimeRegistry } from "../src/adapters/runtime-registry.js";
import { TunnelRuntime } from "../src/adapters/tunnel-runtime.js";
import { CliOutput } from "../src/cli/output.js";
import type { TunnelLifecycleSnapshot } from "../src/domain/tunnel-lifecycle.js";

describe("TunnelRuntime", () => {
  it.effect("exposes ready and reconnecting snapshots from active relay lifecycle", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      const server = yield* listenWebSocketServer();
      const clients: Array<WebSocket> = [];
      const hellos: Array<LocalClientHello> = [];
      server.on("connection", (socket) => {
        clients.push(socket);
        socket.on("message", (data) => {
          const decoded = parseProtocolFrameJson(data.toString());
          if (Result.isSuccess(decoded) && decoded.success.type === "local.hello") {
            hellos.push(decoded.success);
          }
        });
      });
      const port = (server.address() as AddressInfo).port;
      const localRuntime = Layer.mergeAll(
        RuntimeRegistry.layer(sessionsDir),
        LocalControl.layer(sessionsDir),
      ).pipe(Layer.provide(NodeServices.layer));
      const runtimeLayer = TunnelRuntime.live.pipe(
        Layer.provide(localRuntime),
        Layer.provide(Layer.succeed(CliOutput, CliOutput.of({ write: () => Effect.void }))),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* TunnelRuntime;
        yield* runtime
          .run({
            slug: "demo",
            relayDomain: "localhost",
            relaySecret: Redacted.make("secret", { label: "relay-secret" }),
            relayUrl: `ws://127.0.0.1:${port}`,
            poolSize: 1,
            target: { protocol: "http", host: "localhost", port: 5173 },
          })
          .pipe(Effect.forkScoped);

        const ready = yield* waitForSnapshot(runtime, (snapshot) => snapshot.state === "ready");
        expect(ready.connectedRelays).toBe(1);
        expect(ready.relayConnects).toBe(1);
        const firstHello = yield* waitForHello(hellos, 1);
        expect(firstHello.connectedAt).toBe(ready.startedAtMs);

        clients[0]?.terminate();
        const reconnecting = yield* waitForSnapshot(
          runtime,
          (snapshot) => snapshot.state === "reconnecting",
        );
        expect(reconnecting.connectedRelays).toBe(0);
        expect(reconnecting.relayCloses).toBe(1);
        yield* TestClock.adjust("1 second");
        const reconnectedHello = yield* waitForHello(hellos, 2);
        expect(reconnectedHello).toMatchObject({
          sessionId: firstHello.sessionId,
          localClientId: firstHello.localClientId,
          generation: 2,
          connectedAt: firstHello.connectedAt,
        });
      }).pipe(Effect.scoped, Effect.provide(runtimeLayer));
    }),
  );
});

function waitForSnapshot(
  runtime: TunnelRuntime["Service"],
  predicate: (snapshot: TunnelLifecycleSnapshot) => boolean,
): Effect.Effect<TunnelLifecycleSnapshot> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = yield* runtime.snapshot;
      if (snapshot !== undefined && predicate(snapshot)) return snapshot;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    return yield* Effect.die("runtime snapshot did not reach the expected phase");
  });
}

function waitForHello(
  hellos: ReadonlyArray<LocalClientHello>,
  count: number,
): Effect.Effect<LocalClientHello> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const hello = hellos[count - 1];
      if (hello !== undefined) return hello;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    return yield* Effect.die(`relay did not send hello ${count}`);
  });
}

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-runtime-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);

function listenWebSocketServer() {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<WebSocketServer>((resolve, reject) => {
          const server = new WebSocketServer({
            host: "127.0.0.1",
            port: 0,
            handleProtocols: () => LOCAL_CLIENT_SUBPROTOCOL,
          });
          server.once("listening", () => resolve(server));
          server.once("error", reject);
        }),
    ),
    (server) =>
      Effect.sync(() => {
        for (const client of server.clients) client.terminate();
        server.close();
      }),
  );
}
