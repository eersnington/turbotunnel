import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";

import { tunnelReporterLive } from "../src/cli/lifecycle-presenter.js";
import { TerminalSurface } from "../src/cli/terminal-surface.js";
import { TunnelReporter } from "../src/runtime/tunnel-reporter.js";

describe("lifecycle presenter", () => {
  it.effect("releases an interactive terminal before the child can write", () => {
    const writes: Array<string> = [];
    const surfaceLayer = TerminalSurface.layer({
      capabilities: { interactive: true, color: false },
      write: (text) => Effect.sync(() => writes.push(text)),
    });
    const layer = Layer.merge(surfaceLayer, tunnelReporterLive.pipe(Layer.provide(surfaceLayer)));

    return Effect.gen(function* () {
      const reporter = yield* TunnelReporter;
      yield* reporter.emit({ _tag: "DevelopmentProcessStarting", command: "pnpm dev" });
      const afterRelease = writes.join("");
      yield* TestClock.adjust(240);

      expect(afterRelease).toContain("\r\u001B[2K  Process pnpm dev\n");
      expect(writes.join("")).toBe(afterRelease);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders a quiet dev lifecycle transcript in plain mode", () => {
    const writes: Array<string> = [];
    const surfaceLayer = TerminalSurface.layer({
      capabilities: { interactive: false, color: false },
      write: (text) => Effect.sync(() => writes.push(text)),
    });
    const layer = Layer.merge(surfaceLayer, tunnelReporterLive.pipe(Layer.provide(surfaceLayer)));

    return Effect.gen(function* () {
      const reporter = yield* TunnelReporter;
      yield* reporter.emit({ _tag: "DevelopmentProcessStarting", command: "pnpm dev" });
      yield* reporter.emit({ _tag: "DevelopmentProcessStarted" });
      yield* reporter.emit({
        _tag: "LocalApplicationWaiting",
        target: config.target,
      });
      yield* reporter.emit({ _tag: "RelaysConnecting", config });
      yield* reporter.emit({ _tag: "TunnelReady", config, readyAfterMs: 1_400 });
      yield* reporter.emit({
        _tag: "RelayDisconnected",
        connectedRelays: 1,
        configuredRelays: 2,
      });
      yield* reporter.emit({
        _tag: "RelayReconnecting",
        slot: 0,
        attempt: 1,
        retryInMs: 1_000,
      });
      yield* reporter.emit({
        _tag: "RelayReconnecting",
        slot: 0,
        attempt: 2,
        retryInMs: 2_000,
      });
      yield* reporter.emit({ _tag: "RelayRestored", disconnectedForMs: 3_000 });
      yield* reporter.emit({
        _tag: "TunnelStopped",
        summary: {
          wasReady: true,
          durationSeconds: 2_538,
          httpRequests: 128,
          webSocketsOpened: 4,
        },
      });

      expect(writes.join("")).toBe(
        [
          `Turbotunnel v${TURBOTUNNEL_VERSION}`,
          "Starting pnpm dev",
          "Waiting for localhost:5173",
          "Connecting relay sockets",
          "✓ Tunnel ready in 1.4s",
          "",
          "  Public           https://quiet-river-turbotunnel.vercel.app/",
          "  Local            http://localhost:5173",
          "  Process          pnpm dev",
          "",
          "  Press Ctrl-C to stop",
          "! Relay disconnected · reconnecting in 1s",
          "✓ Relay restored after 3s",
          "✓ Tunnel stopped",
          "",
          "  Duration         42m 18s",
          "  Requests         128 HTTP · 4 WebSocket",
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(layer));
  });
});

const config = {
  slug: "quiet-river",
  relayDomain: "{slug}-turbotunnel.vercel.app",
  relaySecret: Redacted.make("secret", { label: "relay-secret" }),
  relayUrl: undefined,
  poolSize: 2,
  target: { protocol: "http" as const, host: "localhost", port: 5173 },
};
