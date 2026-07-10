import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";

import type { GatewayStatsSnapshot } from "./gateway-state.js";

/** Configuration fields projected into the gateway status response. */
export type GatewayStatusConfig = {
  readonly brokerKind: string;
  readonly queueRegion: string;
  readonly baseDomain: string;
};

/** Public gateway status shape. */
export type GatewayStatus = ReturnType<typeof gatewayStatus>;

/** Builds the gateway status projection without performing I/O. */
export function gatewayStatus(
  config: GatewayStatusConfig,
  stats: GatewayStatsSnapshot,
  now: number,
) {
  return Object.fromEntries([
    ["status", "running"],
    ["version", TURBOTUNNEL_VERSION],
    ["baseDomain", config.baseDomain],
    ["broker", config.brokerKind],
    ["queueRegion", config.queueRegion],
    ["uptimeSeconds", Math.round((now - stats.startedAt) / 1000)],
    ["activeLocalClients", stats.activeLocalClients],
    ["directHttpRequests", stats.directHttpRequests],
    ["queuedHttpRequests", stats.queuedHttpRequests],
    ["directWebSocketOpens", stats.directWebSocketOpens],
    ["queuedWebSocketOpens", stats.queuedWebSocketOpens],
    ["queueSends", stats.queueSends],
    ["queueReceives", stats.queueReceives],
    ["queueAcks", stats.queueAcks],
  ] as const);
}

/** Formats a status projection for the gateway's plain-text landing response. */
export function formatGatewayStatus(status: GatewayStatus): string {
  return [
    "Turbotunnel gateway is running.",
    "",
    `Version: ${status.version}`,
    `Base domain: ${status.baseDomain}`,
    `Broker: ${status.broker}`,
    `Queue region: ${status.queueRegion}`,
    `Uptime: ${formatDurationSeconds(status.uptimeSeconds)}`,
    `Active local clients on this instance: ${status.activeLocalClients}`,
    `Direct HTTP requests on this instance: ${status.directHttpRequests}`,
    `Queued HTTP requests on this instance: ${status.queuedHttpRequests}`,
    `Direct WebSocket opens on this instance: ${status.directWebSocketOpens}`,
    `Queued WebSocket opens on this instance: ${status.queuedWebSocketOpens}`,
    `Queue sends on this instance: ${status.queueSends}`,
    `Queue receives on this instance: ${status.queueReceives}`,
    `Queue acks on this instance: ${status.queueAcks}`,
    "",
    "Connect a local app with: tt http <port>",
  ].join("\n");
}

function formatDurationSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}
