import pc from "picocolors";
import type { CliError } from "effect/unstable/cli";

import type { CliMessage } from "./output.js";
import type { DeployOutput, DeployPlan } from "../domain/deploy-plan.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import type { TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import { gatewayUrl, publicTunnelUrl } from "../domain/tunnel-url.js";
import type { CliFailure } from "../errors.js";
import type { GatewayStatusCheck } from "../adapters/gateway-status-checker.js";

export type DeployMessage =
  | {
      readonly _tag: "Preview";
      readonly plan: DeployPlan;
      readonly account: string;
    }
  | {
      readonly _tag: "Progress";
      readonly message: string;
    }
  | {
      readonly _tag: "Summary";
      readonly output: DeployOutput;
      readonly plan: DeployPlan;
      readonly deploymentUrl: string;
    };

export type OutputRow = {
  readonly glyph?: "success" | "warning" | "info";
  readonly label: string;
  readonly value: string;
};

export type TunnelStoppedSummary = {
  readonly durationSeconds: number;
  readonly httpRequests: number;
  readonly webSocketsOpened: number;
};

export type TunnelMessage =
  | { readonly _tag: "Starting"; readonly config: HttpTunnelConfig }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Stopped"; readonly summary: TunnelStoppedSummary }
  | { readonly _tag: "Warning"; readonly message: string };

export type StatusOutput = {
  readonly tunnels: ReadonlyArray<TunnelLifecycleSnapshot>;
  readonly gateways: ReadonlyArray<GatewayStatusCheck>;
};

export type StatusMessage = {
  readonly format: "terminal" | "json";
  readonly status: StatusOutput;
};

export type FailureMessage =
  | {
      readonly _tag: "Expected";
      readonly output: DeployOutput;
      readonly error: CliFailure | CliError.CliError;
    }
  | {
      readonly _tag: "Unexpected";
      readonly output: DeployOutput;
    };

const LABEL_WIDTH = 16;
const UNEXPECTED_FAILURE_MESSAGE =
  "Unexpected CLI failure. No gateway was deployed and no local tunnel was started.";

/** Renders deploy progress and completion messages to the CLI output contract. */
export function renderDeploy(message: DeployMessage): CliMessage {
  switch (message._tag) {
    case "Preview":
      return {
        _tag: "Text",
        stream: "stderr",
        text: deployPreviewText(message.plan, message.account),
      };
    case "Progress":
      return { _tag: "Text", stream: "stderr", text: message.message };
    case "Summary":
      return message.output._tag === "Json"
        ? { _tag: "Json", stream: "stdout", value: deploySummaryJson(message) }
        : { _tag: "Text", stream: "stderr", text: deploySummaryText(message) };
  }
}

/** Renders tunnel lifecycle messages to stderr. */
export function renderTunnel(message: TunnelMessage): CliMessage {
  switch (message._tag) {
    case "Starting":
      return { _tag: "Text", stream: "stderr", text: tunnelStartingText(message.config) };
    case "Ready":
      return { _tag: "Text", stream: "stderr", text: tunnelReadyText() };
    case "Stopped":
      return { _tag: "Text", stream: "stderr", text: tunnelStoppedText(message.summary) };
    case "Warning":
      return { _tag: "Text", stream: "stderr", text: message.message };
  }
}

/** Renders local runtime status to stderr for humans or stdout for automation. */
export function renderStatus(message: StatusMessage): CliMessage {
  return message.format === "json"
    ? { _tag: "Json", stream: "stdout", value: statusJson(message.status) }
    : { _tag: "Text", stream: "stderr", text: statusText(message.status) };
}

/** Renders expected and unexpected failures for terminal or JSON output. */
export function renderFailure(message: FailureMessage): CliMessage {
  if (message._tag === "Expected") {
    return message.output._tag === "Json"
      ? { _tag: "Json", stream: "stdout", value: errorJson(message.error) }
      : { _tag: "Text", stream: "stderr", text: pc.red(message.error.message) };
  }

  return message.output._tag === "Json"
    ? { _tag: "Json", stream: "stdout", value: unexpectedErrorJson() }
    : { _tag: "Text", stream: "stderr", text: pc.red(UNEXPECTED_FAILURE_MESSAGE) };
}

export function formatRows(rows: ReadonlyArray<OutputRow>): string {
  return rows
    .map((row) => {
      const gutter = row.glyph === undefined ? "  " : `${formatGlyph(row.glyph)} `;
      return `${gutter}${row.label.padEnd(LABEL_WIDTH)} ${row.value}`;
    })
    .join("\n");
}

function deployPreviewText(plan: DeployPlan, account: string): string {
  const heading = plan.reusedSavedTarget
    ? "Redeploying Turbotunnel gateway"
    : "Deploying Turbotunnel gateway";
  const rows = [
    ...(account.length > 0 ? [{ label: "Vercel", value: account }] : []),
    { label: "Project", value: plan.project },
    { label: "Gateway", value: pc.cyan(`https://${plan.publicHost}/`) },
    { label: "Tunnel domain", value: plan.baseDomain },
    { label: "Queue region", value: plan.queueRegion },
    { label: "Config", value: plan.configPath },
  ];

  return `\n${pc.bold(heading)}\n\n${formatRows(rows)}\n`;
}

function deploySummaryText(summary: Extract<DeployMessage, { readonly _tag: "Summary" }>): string {
  const gateway = `https://${summary.plan.publicHost}/`;
  return `\n${formatRows([
    { glyph: "success", label: "Gateway", value: "deployed" },
    { label: "Gateway", value: pc.cyan(gateway) },
    ...(summary.deploymentUrl === gateway
      ? []
      : [{ label: "Deployment", value: pc.cyan(summary.deploymentUrl) }]),
    { label: "Tunnel domain", value: summary.plan.baseDomain },
    { label: "Queue region", value: summary.plan.queueRegion },
    { label: "Config", value: summary.plan.configPath },
    { label: "Next", value: "tt http 5173" },
  ])}\n`;
}

function deploySummaryJson(summary: Extract<DeployMessage, { readonly _tag: "Summary" }>): unknown {
  return {
    status: "success",
    reason: "gateway_deployed",
    data: {
      gatewayUrl: `https://${summary.plan.publicHost}/`,
      deploymentUrl: summary.deploymentUrl,
      project: summary.plan.project,
      tunnelDomain: summary.plan.baseDomain,
      queueRegion: summary.plan.queueRegion,
      configPath: summary.plan.configPath,
    },
    next: [{ command: "tt http 5173", argv: ["tt", "http", "5173"] }],
  };
}

function tunnelStartingText(config: HttpTunnelConfig): string {
  return `\n${pc.bold("Starting tunnel")}\n\n${formatRows([
    { label: "Public URL", value: pc.cyan(publicTunnelUrl(config)) },
    { label: "Local app", value: `http://${config.target.host}:${config.target.port}` },
    { label: "Gateway", value: gatewayUrl(config) },
  ])}\n\nConnecting relay sockets...\n`;
}

function tunnelReadyText(): string {
  return `\n${formatRows([
    { glyph: "success", label: "Tunnel", value: "ready" },
    { label: "Stop", value: "Ctrl-C" },
  ])}\n`;
}

function tunnelStoppedText(summary: TunnelStoppedSummary): string {
  return `\n${formatRows([
    { glyph: "success", label: "Tunnel", value: "stopped" },
    { label: "Duration", value: `${summary.durationSeconds}s` },
    {
      label: "Requests",
      value: `${summary.httpRequests} HTTP, ${summary.webSocketsOpened} WebSocket`,
    },
  ])}\n`;
}

function statusText(status: StatusOutput): string {
  if (status.tunnels.length === 0) return "No local tunnels are running.";

  const tunnels = status.tunnels.map((tunnel) => {
    const gateway = status.gateways.find((candidate) => candidate.url === tunnel.gatewayStatusUrl);
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - tunnel.startedAtMs) / 1_000));
    return formatRows([
      { label: "Gateway", value: gateway?.status === "running" ? "reachable" : "unreachable" },
      { label: "Tunnel", value: tunnel.state === "ready" ? "connected" : tunnel.state },
      { label: "Public", value: pc.cyan(tunnel.publicUrl) },
      { label: "Local", value: tunnel.localUrl },
      { label: "Relays", value: `${tunnel.connectedRelays}/${tunnel.configuredRelays}` },
      { label: "Uptime", value: formatDuration(uptimeSeconds) },
    ]);
  });
  return `\n${pc.bold("Local tunnels")}\n\n${tunnels.join("\n\n")}\n`;
}

function statusJson(status: StatusOutput): unknown {
  return status.tunnels.map((tunnel) => ({
    ...tunnel,
    gateway:
      status.gateways.find((candidate) => candidate.url === tunnel.gatewayStatusUrl)?.status ??
      "unreachable",
  }));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

function errorJson(error: CliFailure | CliError.CliError): unknown {
  return {
    status: "error",
    reason: error._tag,
    message: error.message,
  };
}

function unexpectedErrorJson(): unknown {
  return {
    status: "error",
    reason: "unexpected_failure",
    message: UNEXPECTED_FAILURE_MESSAGE,
  };
}

function formatGlyph(glyph: "success" | "warning" | "info"): string {
  switch (glyph) {
    case "success":
      return pc.green("✓");
    case "warning":
      return pc.yellow("!");
    case "info":
      return pc.cyan("▲");
  }
}
