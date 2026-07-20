import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { NodeServices } from "@effect/platform-node";
import {
  LOCAL_CLIENT_SUBPROTOCOL,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
  type LocalClientHello,
} from "@turbotunnel/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import { WebSocketServer, type WebSocket } from "ws";

import { LocalControl } from "../src/adapters/local-control.js";
import { RuntimeRegistry } from "../src/adapters/runtime-registry.js";
import { TunnelRuntime } from "../src/adapters/tunnel-runtime.js";
import type { TunnelLifecycleSnapshot } from "../src/domain/tunnel-lifecycle.js";
import type { LocalControlError, RuntimeRegistryError } from "../src/errors.js";
import { TunnelReporter } from "../src/runtime/tunnel-reporter.js";
import type { LifecycleEvent } from "../src/runtime/lifecycle-event.js";

describe("TunnelRuntime", () => {
  it.effect("registers a starting snapshot while waiting for the local app", () =>
    Effect.gen(function* () {
      const runtimeDir = yield* temporaryDirectory;
      const localRuntime = Layer.mergeAll(
        RuntimeRegistry.layer(runtimeDir),
        LocalControl.layer(runtimeDir),
      ).pipe(Layer.provide(NodeServices.layer));
      const runtimeLayer = TunnelRuntime.live.pipe(
        Layer.provide(localRuntime),
        Layer.provide(
          Layer.succeed(TunnelReporter, TunnelReporter.of({ emit: () => Effect.void })),
        ),
      );
      const services = Layer.merge(localRuntime, runtimeLayer);

      yield* Effect.gen(function* () {
        const runtime = yield* TunnelRuntime;
        const registry = yield* RuntimeRegistry;
        const control = yield* LocalControl;
        yield* runtime
          .run(
            {
              slug: "demo",
              relayDomain: "localhost",
              relaySecret: Redacted.make("secret", { label: "relay-secret" }),
              relayUrl: "ws://127.0.0.1:1",
              poolSize: 1,
              target: { protocol: "http", host: "localhost", port: 5173 },
              publicHost: "demo.localhost",
              accessPolicy: { type: "public" },
            },
            Effect.never,
          )
          .pipe(Effect.forkScoped);

        const starting = yield* waitForSnapshot(
          registry,
          control,
          (snapshot) => snapshot.state === "starting",
        );
        expect(starting.connectedRelays).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(services));
    }),
  );

  it.effect("exposes ready and reconnecting snapshots from active relay lifecycle", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      const server = yield* listenWebSocketServer();
      const events: Array<LifecycleEvent> = [];
      const hellos: Array<LocalClientHello> = [];
      server.on("connection", (socket) => {
        socket.on("message", (data) => {
          const decoded = parseProtocolFrameJson(data.toString());
          if (Result.isSuccess(decoded) && decoded.success.type === "local.hello") {
            hellos.push(decoded.success);
            socket.send(
              JSON.stringify({
                type: "local.ready",
                protocolVersion: PROTOCOL_VERSION,
                frameId: `ready_${decoded.success.frameId}`,
                publicHost: decoded.success.publicHost,
                routeIdentity: {
                  publicHost: decoded.success.publicHost,
                  policyFingerprint: "policy-v1:public",
                  sessionId: decoded.success.sessionId,
                },
              }),
            );
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
        Layer.provide(
          Layer.succeed(
            TunnelReporter,
            TunnelReporter.of({ emit: (event) => Effect.sync(() => events.push(event)) }),
          ),
        ),
      );
      const services = Layer.merge(localRuntime, runtimeLayer);

      yield* Effect.gen(function* () {
        const runtime = yield* TunnelRuntime;
        const registry = yield* RuntimeRegistry;
        const control = yield* LocalControl;
        yield* runtime
          .run({
            slug: "demo",
            relayDomain: "localhost",
            relaySecret: Redacted.make("secret", { label: "relay-secret" }),
            relayUrl: `ws://127.0.0.1:${port}`,
            poolSize: 1,
            target: { protocol: "http", host: "localhost", port: 5173 },
            publicHost: "demo.localhost",
            accessPolicy: { type: "public" },
          })
          .pipe(Effect.forkScoped);

        const ready = yield* waitForSnapshot(
          registry,
          control,
          (snapshot) => snapshot.state === "ready",
        );
        expect(ready.connectedRelays).toBe(1);
        expect(ready.relayConnects).toBe(1);
        const firstHello = yield* waitForHello(hellos, 1);
        expect(firstHello.connectedAt).toBe(ready.startedAtMs);

        yield* TestClock.adjust("270 seconds");
        const reconnecting = yield* waitForSnapshot(
          registry,
          control,
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
        yield* waitForLifecycleEvent(events, "RelayRestored");
        expect(events.map((event) => event._tag)).toEqual(
          expect.arrayContaining([
            "RelaysConnecting",
            "TunnelReady",
            "RelayReconnecting",
            "RelayRestored",
          ]),
        );
      }).pipe(Effect.scoped, Effect.provide(services));
    }),
  );
});

function waitForSnapshot(
  registry: RuntimeRegistry["Service"],
  control: LocalControl["Service"],
  predicate: (snapshot: TunnelLifecycleSnapshot) => boolean,
): Effect.Effect<TunnelLifecycleSnapshot, RuntimeRegistryError | LocalControlError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [record] = yield* registry.list;
      if (record !== undefined) {
        const snapshot = yield* control.query(record);
        if (predicate(snapshot)) return snapshot;
      }
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

function waitForLifecycleEvent(
  events: ReadonlyArray<LifecycleEvent>,
  tag: LifecycleEvent["_tag"],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (events.some((event) => event._tag === tag)) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    return yield* Effect.die(`lifecycle did not emit ${tag}`);
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
