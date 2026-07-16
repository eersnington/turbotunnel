import pc from "picocolors";
import type { CliError } from "effect/unstable/cli";

import type { CliMessage } from "./output.js";
import type { DeployOutput, DeployPlan } from "../domain/deploy-plan.js";
import type { TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import type { CliFailure } from "../errors.js";
import type { GatewayStatusCheck } from "../adapters/gateway-status-checker.js";
import type { TunnelListResponse } from "@turbotunnel/contracts";

export type DeployMessage =
  | {
      readonly _tag: "Preview";
      readonly plan: DeployPlan;
      readonly account: string;
    }
  | {
      readonly _tag: "Progress";
      readonly phase: DeployPhase;
    }
  | {
      readonly _tag: "Summary";
      readonly output: DeployOutput;
      readonly plan: DeployPlan;
      readonly deploymentUrl: string;
    };

export type DeployPhase =
  | "GeneratingWorkspace"
  | "LinkingProject"
  | "SettingEnvironment"
  | "AddingDomain"
  | "DeployingProduction"
  | "VerifyingGateway";

export type OutputRow = {
  readonly glyph?: "success" | "warning" | "info";
  readonly label: string;
  readonly value: string;
};

export type StatusOutput = {
  readonly generatedAt: number;
  readonly tunnels: ReadonlyArray<TunnelLifecycleSnapshot>;
  readonly gateways: ReadonlyArray<GatewayStatusCheck>;
};

export type StatusMessage = {
  readonly format: "terminal" | "json";
  readonly status: StatusOutput;
};

export type TunnelListFormat = "terminal" | "json";

export type TunnelListMessage = {
  readonly format: TunnelListFormat;
  readonly response: TunnelListResponse;
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
  "Unexpected CLI failure. Local work was stopped; remote work may have completed.";

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
      return { _tag: "Text", stream: "stderr", text: deployProgressText(message.phase) };
    case "Summary":
      return message.output._tag === "Json"
        ? { _tag: "Json", stream: "stdout", value: deploySummaryJson(message) }
        : { _tag: "Text", stream: "stderr", text: deploySummaryText(message) };
  }
}

export function renderDeployTerminal(message: DeployMessage, colors: ColorPalette = pc): string {
  switch (message._tag) {
    case "Preview":
      return deployPreviewText(message.plan, message.account, colors);
    case "Progress":
      return deployProgressText(message.phase);
    case "Summary":
      return deploySummaryText(message, colors);
  }
}

/** Renders local runtime status to stderr for humans or stdout for automation. */
export function renderStatus(message: StatusMessage): CliMessage {
  return message.format === "json"
    ? { _tag: "Json", stream: "stdout", value: statusJson(message.status) }
    : { _tag: "Text", stream: "stderr", text: statusText(message.status) };
}

/** Renders connected gateway tunnels to stderr for humans or stdout for automation. */
export function renderTunnelList(message: TunnelListMessage): CliMessage {
  return message.format === "json"
    ? { _tag: "Json", stream: "stdout", value: message.response }
    : { _tag: "Text", stream: "stderr", text: tunnelListText(message.response) };
}

/** Renders expected and unexpected failures for terminal or JSON output. */
export function renderFailure(message: FailureMessage): CliMessage {
  if (message._tag === "Expected") {
    return message.output._tag === "Json"
      ? { _tag: "Json", stream: "stdout", value: errorJson(message.error) }
      : { _tag: "Text", stream: "stderr", text: failureText(message.error) };
  }

  return message.output._tag === "Json"
    ? { _tag: "Json", stream: "stdout", value: unexpectedErrorJson() }
    : { _tag: "Text", stream: "stderr", text: unexpectedFailureText() };
}

type ColorPalette = ReturnType<typeof pc.createColors>;

export function formatRows(rows: ReadonlyArray<OutputRow>, colors: ColorPalette = pc): string {
  return rows
    .map((row) => {
      const gutter = row.glyph === undefined ? "  " : `${formatGlyph(row.glyph, colors)} `;
      return `${gutter}${row.label.padEnd(LABEL_WIDTH)} ${row.value}`;
    })
    .join("\n");
}

function deployPreviewText(plan: DeployPlan, account: string, colors: ColorPalette = pc): string {
  const heading = plan.reusedSavedTarget
    ? "Redeploying Turbotunnel gateway"
    : "Deploying Turbotunnel gateway";
  const rows = [
    ...(account.length > 0 ? [{ label: "Vercel", value: account }] : []),
    { label: "Project", value: plan.project },
    { label: "Gateway", value: colors.cyan(`https://${plan.publicHost}/`) },
    { label: "Tunnel domain", value: plan.baseDomain },
    { label: "Queue region", value: plan.queueRegion },
    { label: "Config", value: plan.configPath },
  ];

  return `\n${colors.bold(heading)}\n\n${formatRows(rows, colors)}\n`;
}

function deployProgressText(phase: DeployPhase): string {
  switch (phase) {
    case "GeneratingWorkspace":
      return "Generating gateway files";
    case "LinkingProject":
      return "Linking Vercel project";
    case "SettingEnvironment":
      return "Setting gateway Environment Variables";
    case "AddingDomain":
      return "Adding gateway domain";
    case "DeployingProduction":
      return "Deploying gateway";
    case "VerifyingGateway":
      return "Verifying gateway";
  }
}

function deploySummaryText(
  summary: Extract<DeployMessage, { readonly _tag: "Summary" }>,
  colors: ColorPalette = pc,
): string {
  const gateway = `https://${summary.plan.publicHost}/`;
  return `\n${formatRows(
    [
      { glyph: "success", label: "Gateway", value: "deployed" },
      { label: "Gateway", value: colors.cyan(gateway) },
      ...(summary.deploymentUrl === gateway
        ? []
        : [{ label: "Deployment", value: colors.cyan(summary.deploymentUrl) }]),
      { label: "Tunnel domain", value: summary.plan.baseDomain },
      { label: "Queue region", value: summary.plan.queueRegion },
      { label: "Config", value: summary.plan.configPath },
      { label: "Next", value: "tt http 5173" },
    ],
    colors,
  )}\n`;
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

function statusText(status: StatusOutput): string {
  if (status.tunnels.length === 0) return "No local tunnels are running.";

  const tunnels = status.tunnels.map((tunnel) => {
    const gateway = status.gateways.find((candidate) => candidate.url === tunnel.gatewayStatusUrl);
    const uptimeSeconds = Math.max(
      0,
      Math.floor((status.generatedAt - tunnel.startedAtMs) / 1_000),
    );
    const tunnelRow: OutputRow =
      tunnel.state === "ready"
        ? { glyph: "success", label: "Tunnel", value: "ready" }
        : tunnel.state === "reconnecting"
          ? { glyph: "warning", label: "Tunnel", value: "reconnecting" }
          : { label: "Tunnel", value: tunnel.state };
    return formatRows([
      tunnelRow,
      { label: "Public", value: pc.cyan(tunnel.publicUrl) },
      { label: "Local", value: tunnel.localUrl },
      { label: "Gateway", value: gateway?.status === "running" ? "reachable" : "unreachable" },
      { label: "Relays", value: `${tunnel.connectedRelays}/${tunnel.configuredRelays}` },
      { label: "Uptime", value: formatDuration(uptimeSeconds) },
    ]);
  });
  return `\n${pc.bold("Local tunnels")}\n\n${tunnels.join("\n\n")}\n`;
}

function statusJson(status: StatusOutput): unknown {
  return status.tunnels.map((tunnel) => ({
    ...tunnel,
    uptimeSeconds: Math.max(0, Math.floor((status.generatedAt - tunnel.startedAtMs) / 1_000)),
    gateway:
      status.gateways.find((candidate) => candidate.url === tunnel.gatewayStatusUrl)?.status ??
      "unreachable",
  }));
}

function tunnelListText(response: TunnelListResponse): string {
  if (response.tunnels.length === 0) return "No tunnels are connected.";

  const rows = response.tunnels.map((tunnel) => [
    tunnel.slug,
    `${tunnel.target.host}:${tunnel.target.port}`,
    formatDuration(Math.max(0, Math.floor((response.generatedAt - tunnel.connectedAt) / 1_000))),
    String(tunnel.relayCount),
  ]);
  const headings = ["SLUG", "TARGET", "CONNECTED", "RELAYS"];
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const table = [headings, ...rows]
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? cell.length) + 2),
        )
        .join("")
        .trimEnd(),
    )
    .join("\n");
  return `\n${pc.bold("Connected tunnels")}\n\n${table}\n`;
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

function unexpectedFailureText(): string {
  return `${pc.red("✖")} ${UNEXPECTED_FAILURE_MESSAGE}\n\n${formatRows([
    { label: "Attempted", value: "Stopped local resources still controlled by this command." },
    { label: "Preserved", value: "Existing saved configuration was not intentionally replaced." },
    { label: "Next", value: "Rerun the command; report the failure if it repeats." },
  ])}`;
}

function failureText(error: CliFailure | CliError.CliError): string {
  const context = failureContext(error._tag);
  return `${pc.red("✖")} ${error.message}\n\n${formatRows([
    { label: "Attempted", value: context.attempted },
    { label: "Preserved", value: context.preserved },
    { label: "Next", value: context.next },
  ])}`;
}

function failureContext(tag: string): {
  readonly attempted: string;
  readonly preserved: string;
  readonly next: string;
} {
  if (
    [
      "ProjectNotFound",
      "ProjectManifestError",
      "UnsupportedPackageManager",
      "ConflictingLockfiles",
      "DevScriptNotFound",
      "PortAllocationError",
      "DevProcessError",
      "DevServerReadinessTimeout",
    ].includes(tag)
  ) {
    return {
      attempted: "Resolved the project, process, local app, and tunnel requirements.",
      preserved: "Turbotunnel requested shutdown for any managed process and tunnel it started.",
      next: "Correct the issue above, then rerun `tt dev`.",
    };
  }
  if (tag === "LocalTargetNotReachable") {
    return {
      attempted: "Checked the configured local host and port before opening the tunnel.",
      preserved: "The local application was not changed and no tunnel was started.",
      next: "Start the local app or correct `--host` and the port, then retry.",
    };
  }
  if (["RuntimeRegistryError", "LocalControlError"].includes(tag)) {
    return {
      attempted: "Used the authenticated local runtime registry and control endpoint.",
      preserved: "Tunnel processes not owned by this command were not stopped.",
      next: "Apply the recovery action above, then rerun the original command.",
    };
  }
  if (tag === "NoGatewayConfigured") {
    return {
      attempted: "Looked for a saved or explicitly provided gateway configuration.",
      preserved: "No gateway or running tunnel was changed.",
      next: "Run `tt deploy`, then retry the original command.",
    };
  }
  if (tag === "GatewayControlError") {
    return {
      attempted: "Contacted the configured gateway using the saved relay credentials.",
      preserved: "The gateway and connected tunnels were not changed.",
      next: "Apply the recovery action above, then rerun `tt list`.",
    };
  }
  if (tag === "GatewayVerificationError") {
    return {
      attempted: "Deployed the gateway, then checked its public status endpoint.",
      preserved: "The previous local Turbotunnel configuration remains intact.",
      next: "Check the deployment logs, then rerun `tt deploy`.",
    };
  }
  if (tag === "VercelCliNotFound") {
    return {
      attempted: "Checked for the Vercel CLI before preparing a deployment.",
      preserved: "No gateway was deployed and the saved configuration was not changed.",
      next: "Install the Vercel CLI, then rerun `tt deploy`.",
    };
  }
  if (tag === "GatewayWorkspaceError") {
    return {
      attempted: "Prepared the local gateway deployment workspace.",
      preserved: "No Vercel deployment was started and saved configuration was not changed.",
      next: "Resolve the file-system issue above, then rerun `tt deploy`.",
    };
  }
  if (["VercelCliFailed", "DeployOutputParseError"].includes(tag)) {
    return {
      attempted: "Ran the current Vercel deployment step.",
      preserved: "The saved local gateway configuration was not replaced.",
      next: "Resolve the Vercel issue above, then rerun `tt deploy`.",
    };
  }
  if (tag === "ConfigFileWriteError") {
    return {
      attempted: "Completed the operation, then tried to save its local configuration.",
      preserved: "The completed remote work may still be active; inspect the local configuration.",
      next: "Fix file permissions, inspect the configuration, then rerun the command if needed.",
    };
  }
  return {
    attempted: "Validated the command and available local configuration.",
    preserved: "No new tunnel or deployment was completed.",
    next: "Correct the issue above, then rerun the command.",
  };
}

function formatGlyph(glyph: "success" | "warning" | "info", colors: ColorPalette): string {
  switch (glyph) {
    case "success":
      return colors.green("✓");
    case "warning":
      return colors.yellow("!");
    case "info":
      return colors.cyan("▲");
  }
}
