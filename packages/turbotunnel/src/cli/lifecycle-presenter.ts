import pc from "picocolors";
import { Effect, Layer, Ref } from "effect";
import qrcode from "qrcode-generator";

import { gatewayUrl, publicTunnelUrl } from "../domain/tunnel-url.js";
import type { LifecycleEvent, TunnelStoppedSummary } from "../runtime/lifecycle-event.js";
import { TunnelReporter } from "../runtime/tunnel-reporter.js";
import { formatRows } from "./messages.js";
import { TerminalSurface } from "./terminal-surface.js";

export const tunnelReporterLive = Layer.effect(
  TunnelReporter,
  Effect.gen(function* () {
    const surface = yield* TerminalSurface;
    const reconnectNoticeVisible = yield* Ref.make(false);
    const developmentOutputVisible = yield* Ref.make(false);
    const tunnelUrl = yield* Ref.make<string | undefined>(undefined);
    const colors = pc.createColors(surface.capabilities.color);

    const emit = (event: LifecycleEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "DomainConfiguring":
          return surface.progress(`Configuring Vercel domain ${terminalText(event.hostname)}`);
        case "TunnelStarting": {
          return Ref.set(tunnelUrl, publicTunnelUrl(event.config)).pipe(
            Effect.andThen(surface.settle(renderStarting(event, colors))),
          );
        }
        case "LocalApplicationWaiting":
          return surface.progress(
            `Waiting for local app at ${event.target.host}:${event.target.port}`,
          );
        case "LocalApplicationReady":
          return surface.append(`${colors.green("✓")} Local app ready`);
        case "DevelopmentOutputStarting":
          return surface
            .settle(renderOutputBoundary("dev server", colors))
            .pipe(
              Effect.andThen(Ref.set(developmentOutputVisible, true)),
              Effect.andThen(surface.releaseToChild),
            );
        case "RelaysConnecting":
          return Ref.getAndSet(developmentOutputVisible, false).pipe(
            Effect.flatMap((showBoundary) =>
              showBoundary
                ? surface.append(`\n${renderOutputBoundary("turbotunnel", colors)}`)
                : Effect.void,
            ),
            Effect.andThen(surface.progress(`Connecting ${event.configuredRelays} relay sockets`)),
          );
        case "TunnelReady":
          return Ref.get(tunnelUrl).pipe(
            Effect.flatMap((url) =>
              surface.settle(
                renderReady(event, colors, surface.capabilities.interactive ? url : undefined),
              ),
            ),
          );
        case "RelayReconnecting":
          return Ref.getAndSet(reconnectNoticeVisible, true).pipe(
            Effect.flatMap((alreadyVisible) =>
              alreadyVisible
                ? Effect.void
                : surface.append(
                    `${colors.yellow("!")} Relay disconnected · reconnecting automatically`,
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
  colors: ReturnType<typeof pc.createColors>,
  publicUrl: string | undefined,
): string {
  const qrCode =
    publicUrl === undefined ? "" : `  Scan to open\n\n${indent(renderQrCode(publicUrl))}\n\n`;
  return `${colors.green("✓")} Tunnel ready in ${formatDurationMs(event.readyAfterMs)}\n\n${qrCode}  Press Ctrl-C to stop\n`;
}

function renderQrCode(value: string): string {
  const code = qrcode(0, "L");
  code.addData(value);
  code.make();

  const margin = 2;
  const size = code.getModuleCount();
  const lines: Array<string> = [];
  for (let row = -margin; row < size + margin; row += 2) {
    let line = "\u001B[47m\u001B[30m";
    for (let column = -margin; column < size + margin; column += 1) {
      const top = isDark(code, row, column, size);
      const bottom = isDark(code, row + 1, column, size);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`${line}\u001B[0m`);
  }
  return lines.join("\n");
}

function isDark(
  code: ReturnType<typeof qrcode>,
  row: number,
  column: number,
  size: number,
): boolean {
  return row >= 0 && row < size && column >= 0 && column < size && code.isDark(row, column);
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderStarting(
  event: Extract<LifecycleEvent, { readonly _tag: "TunnelStarting" }>,
  colors: ReturnType<typeof pc.createColors>,
): string {
  const publicUrl = publicTunnelUrl(event.config);
  const localUrl = `http://${event.config.target.host}:${event.config.target.port}`;
  const gateway = gatewayUrl(event.config);
  return `${formatRows(
    [
      { label: "Public", value: colors.cyan(publicUrl) },
      { label: "Local", value: colors.cyan(localUrl) },
      ...(gateway === publicUrl ? [] : [{ label: "Gateway", value: colors.cyan(gateway) }]),
      { label: "Relays", value: `${event.config.poolSize} sockets` },
      {
        label: "Access",
        value:
          event.config.accessPolicy.type === "public"
            ? "public"
            : event.config.accessPolicy.type === "password"
              ? "password"
              : `IP allowlist (${event.config.accessPolicy.cidrs.length})`,
      },
      ...(event.launch._tag === "ManagedProcess"
        ? [
            { label: "Process", value: event.launch.command },
            { label: "Directory", value: colors.dim(event.launch.directory) },
          ]
        : []),
    ],
    colors,
  )}\n\n`;
}

function renderOutputBoundary(label: string, colors: ReturnType<typeof pc.createColors>): string {
  return `${colors.dim("────")} ${colors.cyan(label)} ${colors.dim("────────────────────────")}`;
}

function renderStopped(
  summary: TunnelStoppedSummary,
  colors: ReturnType<typeof pc.createColors>,
): string {
  return `\n${colors.green("✓")} Tunnel stopped\n\n${formatRows(
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
