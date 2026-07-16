import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { LocalControl } from "../src/adapters/local-control.js";
import {
  decodeControlResponse,
  type RuntimeRecord,
  type TunnelLifecycleSnapshot,
} from "../src/domain/tunnel-lifecycle.js";

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

  it.effect("rejects lifecycle states that disagree with relay counts", () =>
    Effect.gen(function* () {
      const invalidSnapshots = [
        { ...snapshot, state: "ready", connectedRelays: 1 },
        { ...snapshot, state: "starting", connectedRelays: 1 },
        { ...snapshot, state: "connecting", connectedRelays: 2 },
        { ...snapshot, state: "reconnecting", connectedRelays: 2 },
        { ...snapshot, state: "connecting", connectedRelays: 3 },
      ] as const;

      for (const invalidSnapshot of invalidSnapshots) {
        const error = yield* decodeControlResponse({
          version: 1,
          status: "ok",
          snapshot: invalidSnapshot,
        }).pipe(Effect.flip);
        expect(error).toBeDefined();
      }
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
  state: "connecting",
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
