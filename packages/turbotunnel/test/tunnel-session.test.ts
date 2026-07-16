import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import type { LifecycleEvent } from "../src/runtime/lifecycle-event.js";
import { makeTunnelSession } from "../src/runtime/tunnel-session.js";

describe("TunnelSession", () => {
  it.effect("emits readiness only when the configured relay pool is connected", () =>
    Effect.gen(function* () {
      const events: Array<LifecycleEvent> = [];
      const session = yield* makeTunnelSession({
        config,
        sessionId: "ses_test",
        pid: 123,
        startedAtMs: 1_000,
        reporter: { emit: (event) => Effect.sync(() => events.push(event)) },
      });

      yield* session.relayWorkersStarted;
      yield* session.relayConnected(0, 1_400);
      expect(session.snapshot()).toMatchObject({ state: "connecting", connectedRelays: 1 });
      expect(events).toEqual([]);

      yield* session.relayConnected(1, 1_800);
      expect(session.snapshot()).toMatchObject({ state: "ready", connectedRelays: 2 });
      expect(events).toEqual([expect.objectContaining({ _tag: "TunnelReady", readyAfterMs: 800 })]);
    }),
  );

  it.effect("coalesces a pool outage into one disconnect and one restoration event", () =>
    Effect.gen(function* () {
      const events: Array<LifecycleEvent> = [];
      const session = yield* makeTunnelSession({
        config,
        sessionId: "ses_test",
        pid: 123,
        startedAtMs: 1_000,
        reporter: { emit: (event) => Effect.sync(() => events.push(event)) },
      });

      yield* session.relayWorkersStarted;
      yield* session.relayConnected(0, 1_100);
      yield* session.relayConnected(1, 1_200);
      events.length = 0;

      yield* session.relayClosed({
        slot: 0,
        nowMs: 2_000,
      });
      yield* session.relayReconnecting(0, 1_000);
      yield* session.relayReconnecting(0, 2_000);
      yield* session.relayClosed({
        slot: 1,
        nowMs: 2_100,
      });
      yield* session.relayReconnecting(1, 1_000);
      yield* session.relayConnected(0, 3_000);
      yield* session.relayConnected(1, 5_000);

      expect(events).toEqual([
        expect.objectContaining({ _tag: "RelayDisconnected", connectedRelays: 1 }),
        { _tag: "RelayReconnecting", slot: 0, attempt: 1, retryInMs: 1_000 },
        { _tag: "RelayReconnecting", slot: 0, attempt: 2, retryInMs: 2_000 },
        { _tag: "RelayReconnecting", slot: 1, attempt: 1, retryInMs: 1_000 },
        { _tag: "RelayRestored", disconnectedForMs: 3_000 },
      ]);
      expect(session.snapshot()).toMatchObject({ state: "ready", reconnects: 2 });
    }),
  );

  it.effect("derives shutdown counters from lifecycle operations", () =>
    Effect.gen(function* () {
      const session = yield* makeTunnelSession({
        config,
        sessionId: "ses_test",
        pid: 123,
        startedAtMs: 1_000,
        reporter: { emit: () => Effect.void },
      });

      yield* session.recordHttpRequest;
      yield* session.recordHttpRequest;
      yield* session.recordWebSocketOpened;
      expect(yield* session.recordInvalidFrame).toBe(true);
      expect(yield* session.recordInvalidFrame).toBe(false);

      expect(session.stoppedSummary(43_000)).toEqual({
        wasReady: false,
        durationSeconds: 42,
        httpRequests: 2,
        webSocketsOpened: 1,
      });
      expect(session.snapshot().invalidFrames).toBe(2);
    }),
  );
});

const config = {
  slug: "demo",
  relayDomain: "tunnel.example.com",
  relaySecret: Redacted.make("secret", { label: "relay-secret" }),
  relayUrl: undefined,
  poolSize: 2,
  target: { protocol: "http" as const, host: "localhost", port: 5173 },
};
