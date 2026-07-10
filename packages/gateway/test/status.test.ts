import { describe, expect, test } from "vitest";

import { formatGatewayStatus, gatewayStatus } from "../src/gateway-status.js";

describe("gatewayStatus", () => {
  test("projects counters and elapsed uptime", () => {
    expect(
      gatewayStatus(
        { brokerKind: "memory", queueRegion: "iad1", baseDomain: "tunnel.test" },
        {
          startedAt: 1_000,
          activeLocalClients: 2,
          directHttpRequests: 3,
          queuedHttpRequests: 4,
          directWebSocketOpens: 5,
          queuedWebSocketOpens: 6,
          queueSends: 7,
          queueReceives: 8,
          queueAcks: 9,
        },
        66_000,
      ),
    ).toEqual({
      status: "running",
      version: "0.1.0",
      baseDomain: "tunnel.test",
      broker: "memory",
      queueRegion: "iad1",
      uptimeSeconds: 65,
      activeLocalClients: 2,
      directHttpRequests: 3,
      queuedHttpRequests: 4,
      directWebSocketOpens: 5,
      queuedWebSocketOpens: 6,
      queueSends: 7,
      queueReceives: 8,
      queueAcks: 9,
    });
  });
});

describe("formatGatewayStatus", () => {
  test("formats the established text landing response", () => {
    const status = gatewayStatus(
      { brokerKind: "memory", queueRegion: "iad1", baseDomain: "tunnel.test" },
      {
        startedAt: 1_000,
        activeLocalClients: 0,
        directHttpRequests: 1,
        queuedHttpRequests: 2,
        directWebSocketOpens: 3,
        queuedWebSocketOpens: 4,
        queueSends: 5,
        queueReceives: 6,
        queueAcks: 7,
      },
      126_000,
    );

    expect(formatGatewayStatus(status)).toBe(
      [
        "Turbotunnel gateway is running.",
        "",
        "Version: 0.1.0",
        "Base domain: tunnel.test",
        "Broker: memory",
        "Queue region: iad1",
        "Uptime: 2m 5s",
        "Active local clients on this instance: 0",
        "Direct HTTP requests on this instance: 1",
        "Queued HTTP requests on this instance: 2",
        "Direct WebSocket opens on this instance: 3",
        "Queued WebSocket opens on this instance: 4",
        "Queue sends on this instance: 5",
        "Queue receives on this instance: 6",
        "Queue acks on this instance: 7",
        "",
        "Connect a local app with: tt http <port>",
      ].join("\n"),
    );
  });
});
