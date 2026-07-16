import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

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
      expect(afterRelease).toContain("https://quiet-river-turbotunnel.vercel.app/");
      expect(afterRelease).toContain("pnpm dev");
      expect(afterRelease).toContain("/repo");
      expect(writes.join("")).toBe(afterRelease);
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
