import pc from "picocolors";
import { Effect, Layer, Ref } from "effect";

import { publicTunnelUrl } from "../domain/tunnel-url.js";
import type { LifecycleEvent, TunnelStoppedSummary } from "../runtime/lifecycle-event.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { formatRows } from "./messages.js";
import { TerminalSurface } from "./terminal-surface.js";

export const tunnelReporterLive = Layer.effect(
  TunnelReporter,
  Effect.gen(function* () {
    const surface = yield* TerminalSurface;
    const processCommand = yield* Ref.make<string | undefined>(undefined);
    const reconnectNoticeVisible = yield* Ref.make(false);
    const colors = pc.createColors(surface.capabilities.color);

    const emit = (event: LifecycleEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "DevelopmentProcessStarting":
          return Ref.set(processCommand, event.command).pipe(
            Effect.andThen(surface.progress(`Starting ${event.command}`)),
            Effect.andThen(surface.releaseToChild(`Process ${event.command}`)),
          );
        case "DevelopmentProcessStarted":
          return Effect.void;
        case "LocalApplicationWaiting":
          return surface.progress(`Waiting for ${event.target.host}:${event.target.port}`);
        case "RelaysConnecting":
          return surface.progress("Connecting relay sockets");
        case "TunnelReady":
          return Ref.get(processCommand).pipe(
            Effect.flatMap((command) => surface.settle(renderReady(event, command, colors))),
          );
        case "RelayDisconnected":
          return Ref.set(reconnectNoticeVisible, false);
        case "RelayReconnecting":
          return Ref.getAndSet(reconnectNoticeVisible, true).pipe(
            Effect.flatMap((alreadyVisible) =>
              alreadyVisible
                ? Effect.void
                : surface.append(
                    `${colors.yellow("!")} Relay disconnected · reconnecting in ${formatDurationMs(event.retryInMs)}`,
                  ),
            ),
          );
        case "RelayRestored":
          return Ref.set(reconnectNoticeVisible, false).pipe(
            Effect.andThen(
              surface.append(
                `${colors.green("✓")} Relay restored after ${formatDurationMs(event.disconnectedForMs)}`,
              ),
            ),
          );
        case "RecoverableWarning":
          return surface.append(
            `${colors.yellow("!")} ${terminalText(event.warning.failure)}\n  ${terminalText(event.warning.attemptedRecovery)} ${terminalText(event.warning.impact)}`,
          );
        case "Stopping":
          return Effect.void;
        case "TunnelStopped":
          return event.summary.wasReady
            ? surface.settle(renderStopped(event.summary, colors))
            : Effect.void;
        case "UnrecoverableFailure":
          return surface.close;
      }
    };

    return TunnelReporter.of({ emit });
  }),
);

function renderReady(
  event: Extract<LifecycleEvent, { readonly _tag: "TunnelReady" }>,
  processCommand: string | undefined,
  colors: ReturnType<typeof pc.createColors>,
): string {
  const localUrl = `http://${event.config.target.host}:${event.config.target.port}`;
  const rows = [
    { label: "Public", value: colors.cyan(publicTunnelUrl(event.config)) },
    { label: "Local", value: localUrl },
    ...(processCommand === undefined ? [] : [{ label: "Process", value: processCommand }]),
  ];
  return `${colors.green("✓")} Tunnel ready in ${formatDurationMs(event.readyAfterMs)}\n\n${formatRows(rows, colors)}\n\n  Press Ctrl-C to stop\n`;
}

function renderStopped(
  summary: TunnelStoppedSummary,
  colors: ReturnType<typeof pc.createColors>,
): string {
  return `${colors.green("✓")} Tunnel stopped\n\n${formatRows(
    [
      { label: "Duration", value: formatDuration(summary.durationSeconds) },
      {
        label: "Requests",
        value: `${summary.httpRequests} HTTP · ${summary.webSocketsOpened} WebSocket`,
      },
    ],
    colors,
  )}\n`;
}

function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(remainder > 0 || (hours === 0 && minutes === 0) ? [`${remainder}s`] : []),
  ].join(" ");
}

function terminalText(text: string): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? JSON.stringify(character).slice(1, -1)
      : character;
  }).join("");
}
