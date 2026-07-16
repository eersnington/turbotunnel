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
      yield* reporter.emit({
        _tag: "TunnelStarting",
        config,
        launch: { _tag: "ManagedProcess", command: "pnpm dev", directory: "/repo" },
      });
      yield* reporter.emit({
        _tag: "LocalApplicationWaiting",
        target: config.target,
      });
      yield* reporter.emit({ _tag: "DevelopmentOutputStarting" });
      const afterRelease = writes.join("");
      yield* TestClock.adjust(240);

      expect(afterRelease).toContain(". turbotunnel");
      expect(afterRelease).toContain(
        "  Public           https://quiet-river-turbotunnel.vercel.app/",
      );
      expect(afterRelease).toContain("  Process          pnpm dev");
      expect(afterRelease).toContain("  Directory        /repo");
      expect(afterRelease).toContain("──── dev server ────────────────────────");
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
      yield* reporter.emit({
        _tag: "TunnelStarting",
        config,
        launch: { _tag: "ManagedProcess", command: "pnpm dev", directory: "/repo" },
      });
      yield* reporter.emit({
        _tag: "LocalApplicationWaiting",
        target: config.target,
      });
      yield* reporter.emit({ _tag: "DevelopmentOutputStarting" });
      yield* reporter.emit({ _tag: "RelaysConnecting", configuredRelays: 2 });
      yield* reporter.emit({ _tag: "TunnelReady", readyAfterMs: 1_400 });
      yield* reporter.emit({ _tag: "RelayReconnecting" });
      yield* reporter.emit({ _tag: "RelayReconnecting" });
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
          `. turbotunnel ${TURBOTUNNEL_VERSION}`,
          "",
          "  Public           https://quiet-river-turbotunnel.vercel.app/",
          "  Local            http://localhost:5173",
          "  Relays           2 sockets",
          "  Process          pnpm dev",
          "  Directory        /repo",
          "",
          "Waiting for local app at localhost:5173",
          "──── dev server ────────────────────────",
          "",
          "──── turbotunnel ────────────────────────",
          "✓ Local app ready",
          "· Connecting 2 relay sockets",
          "✓ Tunnel ready in 1.4s",
          "",
          "  Press Ctrl-C to stop",
          "! Relay disconnected · reconnecting automatically",
          "✓ Relay restored after 3s",
          "",
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
