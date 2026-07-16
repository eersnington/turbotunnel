import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { LocalControl } from "../src/adapters/local-control.js";
import type { RuntimeRecord, TunnelLifecycleSnapshot } from "../src/domain/tunnel-lifecycle.js";

describe("LocalControl", () => {
  it.effect("serves snapshots only to the matching process token", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* temporaryDirectory;
      yield* Effect.gen(function* () {
        const control = yield* LocalControl;
        const handle = yield* control.open({
          sessionId: snapshot.sessionId,
          processToken: "correct-token",
          snapshot: () => snapshot,
        });
        const record: RuntimeRecord = {
          version: 1,
          sessionId: snapshot.sessionId,
          pid: snapshot.pid,
          processToken: "correct-token",
          startedAt: snapshot.startedAtMs,
          slug: "demo",
          publicUrl: snapshot.publicUrl,
          localUrl: snapshot.localUrl,
          controlSocketPath: handle.endpoint,
        };

        expect(yield* control.query(record)).toEqual(snapshot);
        const error = yield* control
          .query({ ...record, processToken: "wrong-token" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("LocalControlError");
        expect(error.operation).toBe("protocol");
      }).pipe(Effect.scoped, Effect.provide(LocalControl.layer(sessionsDir)));
    }),
  );
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-control-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);

const snapshot: TunnelLifecycleSnapshot = {
  version: 1,
  sessionId: "ses_control",
  pid: 123,
  state: "ready",
  startedAtMs: 1_000,
  publicUrl: "https://demo.example.com/",
  localUrl: "http://localhost:5173",
  gatewayStatusUrl: "https://demo.example.com/_turbotunnel/status",
  configuredRelays: 2,
  connectedRelays: 1,
  relayConnects: 1,
  relayCloses: 0,
  relayErrors: 0,
  reconnects: 0,
  framesReceived: 0,
  framesSent: 1,
  invalidFrames: 0,
  httpRequests: 0,
  httpResponses: 0,
  webSocketsOpened: 0,
  webSocketsClosed: 0,
};
