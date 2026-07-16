import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { TerminalSurface, terminalCapabilities } from "../src/cli/terminal-surface.js";

describe("TerminalSurface", () => {
  it.effect("animates one transient line and replaces it with stable output", () => {
    const writes: Array<string> = [];
    return Effect.gen(function* () {
      const surface = yield* TerminalSurface;

      yield* surface.progress("Connecting relay sockets");
      yield* Effect.yieldNow;
      yield* TestClock.adjust(160);
      yield* surface.settle("✓ Tunnel ready\n");

      const output = writes.join("");
      expect(output).toContain("\u001B[H\u001B[2J");
      expect(output).toContain("⠋ Connecting relay sockets");
      expect(output).toMatch(/[⠙⠹] Connecting relay sockets/u);
      expect(output).toContain("\r\u001B[2K✓ Tunnel ready\n");
    }).pipe(Effect.provide(interactiveLayer(writes)));
  });

  it.effect("emits deterministic milestones without ANSI in plain mode", () => {
    const writes: Array<string> = [];
    return Effect.gen(function* () {
      const surface = yield* TerminalSurface;

      yield* surface.progress("Waiting for localhost:5173");
      yield* surface.progress("Waiting for localhost:5173");
      yield* surface.progress("Connecting relay sockets");
      yield* surface.settle("✓ Tunnel ready");

      const output = writes.join("");
      expect(output).not.toContain("\u001B");
      expect(output.match(/Waiting for localhost:5173/gu)).toHaveLength(1);
      expect(output).toContain("Connecting relay sockets\n✓ Tunnel ready\n");
    }).pipe(Effect.provide(plainLayer(writes)));
  });

  it.effect("stops cursor redraw after releasing the terminal to a child", () => {
    const writes: Array<string> = [];
    return Effect.gen(function* () {
      const surface = yield* TerminalSurface;

      yield* surface.progress("Starting pnpm dev");
      yield* surface.releaseToChild("Process pnpm dev");
      const releaseIndex = writes.length;
      yield* surface.progress("Waiting for localhost:5173");
      yield* surface.append("! Relay disconnected");

      expect(writes.slice(releaseIndex).join("")).toBe(
        "Waiting for localhost:5173\n! Relay disconnected\n",
      );
    }).pipe(Effect.provide(interactiveLayer(writes)));
  });
});

describe("terminalCapabilities", () => {
  it("disables interaction for CI, dumb terminals, and redirected stderr", () => {
    expect(terminalCapabilities({ CI: "1" }, { isTTY: true }).interactive).toBe(false);
    expect(terminalCapabilities({ TERM: "dumb" }, { isTTY: true }).interactive).toBe(false);
    expect(terminalCapabilities({}, { isTTY: false }).interactive).toBe(false);
  });

  it("respects NO_COLOR independently of TTY interaction", () => {
    expect(terminalCapabilities({ NO_COLOR: "1" }, { isTTY: true })).toEqual({
      interactive: true,
      color: false,
    });
  });
});

function interactiveLayer(writes: Array<string>) {
  return TerminalSurface.layer({
    capabilities: { interactive: true, color: false },
    write: (text) => Effect.sync(() => writes.push(text)),
  });
}

function plainLayer(writes: Array<string>) {
  return TerminalSurface.layer({
    capabilities: { interactive: false, color: false },
    write: (text) => Effect.sync(() => writes.push(text)),
  });
}
