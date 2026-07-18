import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { GatewayStatusChecker } from "../src/adapters/gateway-status-checker.js";
import { LocalControl } from "../src/adapters/local-control.js";
import { RuntimeRegistry } from "../src/adapters/runtime-registry.js";
import type { CliMessage } from "../src/cli/output.js";
import { CliOutput } from "../src/cli/output.js";
import type { RuntimeRecord, TunnelLifecycleSnapshot } from "../src/domain/tunnel-lifecycle.js";
import { LocalControlError } from "../src/errors.js";
import { showStatus } from "../src/programs/show-status.js";

describe("showStatus", () => {
  it.effect(
    "lists authenticated tunnels, removes stale records, and checks distinct gateways once",
    () =>
      Effect.gen(function* () {
        const sessionsDir = yield* temporaryDirectory;
        const messages: Array<CliMessage> = [];
        const checkedUrls: Array<string> = [];
        const services = Layer.mergeAll(
          RuntimeRegistry.layer(sessionsDir),
          LocalControl.layer(sessionsDir),
          Layer.succeed(
            GatewayStatusChecker,
            GatewayStatusChecker.of({
              check: (url) =>
                Effect.sync(() => {
                  checkedUrls.push(url);
                  return { url, status: "running" as const, version: "test" };
                }),
            }),
          ),
          Layer.succeed(
            CliOutput,
            CliOutput.of({ write: (message) => Effect.sync(() => messages.push(message)) }),
          ),
        ).pipe(Layer.provide(NodeServices.layer));

        yield* Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const control = yield* LocalControl;
          const handle = yield* control.open({
            sessionId: liveSnapshot.sessionId,
            processToken: "live-token",
            snapshot: () => liveSnapshot,
          });
          yield* registry.register(recordFor(liveSnapshot, "live-token", handle.endpoint));

          const stale = recordFor(
            { ...liveSnapshot, sessionId: "ses_stale", pid: 999 },
            "stale-token",
            join(sessionsDir, "missing.sock"),
          );
          yield* Effect.promise(() =>
            writeFile(join(sessionsDir, "ses_stale.json"), JSON.stringify(stale)),
          );

          yield* TestClock.adjust("61 seconds");
          yield* showStatus({ format: "json" });
          expect((yield* registry.list).map((record) => record.sessionId)).toEqual([
            liveSnapshot.sessionId,
          ]);
        }).pipe(Effect.scoped, Effect.provide(services));

        expect(checkedUrls).toEqual([liveSnapshot.gatewayStatusUrl]);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          _tag: "Json",
          stream: "stdout",
          value: [{ ...liveSnapshot, uptimeSeconds: 60, gateway: "running" }],
        });
      }),
  );

  it.effect("uses human output when no local tunnels are running", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      const messages: Array<CliMessage> = [];
      const services = Layer.mergeAll(
        RuntimeRegistry.layer(sessionsDir),
        LocalControl.layer(sessionsDir),
        Layer.succeed(
          GatewayStatusChecker,
          GatewayStatusChecker.of({
            check: (url) =>
              Effect.succeed({ url, status: "unreachable", reason: "transport-failure" }),
          }),
        ),
        Layer.succeed(
          CliOutput,
          CliOutput.of({ write: (message) => Effect.sync(() => messages.push(message)) }),
        ),
      ).pipe(Layer.provide(NodeServices.layer));

      yield* showStatus({ format: "terminal" }).pipe(Effect.provide(services));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ _tag: "Text", stream: "stderr" });
    }),
  );

  it.effect("fails without removing a tunnel when local control is temporarily unavailable", () =>
    Effect.gen(function* () {
      const record = recordFor(liveSnapshot, "live-token", "/tmp/live.sock");
      let removed = false;
      const services = Layer.mergeAll(
        Layer.succeed(
          RuntimeRegistry,
          RuntimeRegistry.of({
            register: () => Effect.void,
            list: Effect.succeed([record]),
            remove: () =>
              Effect.sync(() => {
                removed = true;
              }),
          }),
        ),
        Layer.succeed(
          LocalControl,
          LocalControl.of({
            open: () => Effect.die("not used"),
            query: () =>
              Effect.fail(
                new LocalControlError({
                  operation: "connect",
                  reason: "temporarily-unavailable",
                  endpoint: record.controlSocketPath,
                  message: "temporarily unavailable",
                }),
              ),
          }),
        ),
        Layer.succeed(
          GatewayStatusChecker,
          GatewayStatusChecker.of({
            check: (url) => Effect.succeed({ url, status: "running", version: "test" }),
          }),
        ),
        Layer.succeed(CliOutput, CliOutput.of({ write: () => Effect.void })),
      );

      const error = yield* showStatus({ format: "json" }).pipe(
        Effect.provide(services),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "LocalControlError", reason: "temporarily-unavailable" });
      expect(removed).toBe(false);
    }),
  );
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-status-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);

const liveSnapshot: TunnelLifecycleSnapshot = {
  version: 1,
  sessionId: "ses_live",
  pid: 123,
  state: "ready",
  startedAtMs: 1_000,
  publicUrl: "https://demo.example.com/",
  localUrl: "http://localhost:5173",
  gatewayStatusUrl: "https://demo.example.com/_turbotunnel/status",
  configuredRelays: 2,
  connectedRelays: 2,
  relayConnects: 2,
  relayCloses: 0,
  relayErrors: 0,
  reconnects: 0,
  framesReceived: 0,
  framesSent: 2,
  invalidFrames: 0,
  httpRequests: 3,
  httpResponses: 3,
  webSocketsOpened: 0,
  webSocketsClosed: 0,
};

function recordFor(
  snapshot: TunnelLifecycleSnapshot,
  processToken: string,
  controlSocketPath: string,
): RuntimeRecord {
  return {
    version: 1,
    sessionId: snapshot.sessionId,
    pid: snapshot.pid,
    processToken,
    startedAt: snapshot.startedAtMs,
    controlSocketPath,
  };
}
