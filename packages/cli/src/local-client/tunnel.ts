import { Buffer } from "node:buffer";

import {
  type Frame,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_CLIENT_SUBPROTOCOL,
  LOCAL_CLIENT_CAPACITY,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
} from "@turbotunnel/protocol";
import { Cause, Console, Effect, Exit, Redacted, Result } from "effect";
import { nanoid } from "nanoid";
import { WebSocket, type RawData } from "ws";

import type { HttpTunnelConfig } from "../config.js";
import { bold, formatRows, url, writeHuman, writeHumanSync } from "../output.js";
import { forwardHttpToLocalAppEffect } from "./forward-http.js";
import { type LocalWebSocketHandle, openLocalWebSocket } from "./forward-ws.js";

type CallbackInterrupt = (interruptor?: number | undefined) => void;

type TunnelSessionStats = {
  readonly startedAtMs: number;
  relayConnects: number;
  relayCloses: number;
  relayErrors: number;
  reconnects: number;
  framesReceived: number;
  framesSent: number;
  invalidFrames: number;
  httpRequests: number;
  httpResponses: number;
  webSocketsOpened: number;
  webSocketsClosed: number;
  readyPrinted: boolean;
};

/** Start a local tunnel process and keep it alive until interrupted. */
export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  config: HttpTunnelConfig,
): Effect.fn.Return<never, never, never> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const stats: TunnelSessionStats = {
        startedAtMs: Date.now(),
        relayConnects: 0,
        relayCloses: 0,
        relayErrors: 0,
        reconnects: 0,
        framesReceived: 0,
        framesSent: 0,
        invalidFrames: 0,
        httpRequests: 0,
        httpResponses: 0,
        webSocketsOpened: 0,
        webSocketsClosed: 0,
        readyPrinted: false,
      };

      yield* printTunnelStarting(config);
      yield* Effect.addFinalizer(() =>
        writeHuman(
          `\n${formatRows([
            { glyph: "✓", label: "Tunnel", value: "stopped" },
            {
              label: "Duration",
              value: `${Math.max(0, Math.round((Date.now() - stats.startedAtMs) / 1000))}s`,
            },
            {
              label: "Requests",
              value: `${stats.httpRequests} HTTP, ${stats.webSocketsOpened} WebSocket`,
            },
          ])}\n`,
        ),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const connections: Array<RelayConnection> = [];
          const sessionId = `ses_${nanoid(12)}`;
          for (let index = 0; index < config.poolSize; index += 1) {
            const connection = new RelayConnection(config, index, sessionId, stats);
            connections.push(connection);
            connection.start();
          }

          return connections;
        }),
        (connections) =>
          Effect.sync(() => {
            for (const connection of connections) {
              connection.stop();
            }
          }),
      );

      return yield* Effect.never;
    }),
  );
});

class RelayConnection {
  private ws: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = 1_000;
  private generation = 0;
  private relayCloseRecorded = false;
  private stopped = false;
  private localClientId = "";
  private readonly activeEffects = new Set<CallbackInterrupt>();
  private readonly localWebSockets = new Map<string, LocalWebSocketHandle>();

  constructor(
    private readonly config: HttpTunnelConfig,
    private readonly index: number,
    private readonly sessionId: string,
    private readonly stats: TunnelSessionStats,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
    }

    for (const interrupt of this.activeEffects) {
      interrupt();
    }
    this.activeEffects.clear();

    for (const socket of this.localWebSockets.values()) {
      socket.dispose();
    }
    this.stats.webSocketsClosed += this.localWebSockets.size;

    this.localWebSockets.clear();
    this.recordRelayClose();
    this.ws?.close(1001, "turbotunnel process stopped");
  }

  private connect(): void {
    this.generation += 1;
    this.relayCloseRecorded = false;
    this.localClientId = `client_${nanoid(12)}`;
    const url = relaySocketUrl(this.config);
    const ws = new WebSocket(url, LOCAL_CLIENT_SUBPROTOCOL, {
      headers: relayHeaders(this.config),
    });

    this.ws = ws;

    ws.on("open", () => {
      this.stats.relayConnects += 1;
      this.reconnectDelayMs = 1_000;
      this.send({
        type: "local.hello",
        protocolVersion: PROTOCOL_VERSION,
        frameId: `frm_${nanoid(12)}`,
        slug: this.config.slug,
        localClientId: this.localClientId,
        sessionId: this.sessionId,
        generation: this.generation,
        capacity: LOCAL_CLIENT_CAPACITY,
        target: this.config.target,
      });

      if (!this.stats.readyPrinted) {
        this.stats.readyPrinted = true;
        writeHumanSync(
          `\n${formatRows([
            { glyph: "✓", label: "Tunnel", value: "ready" },
            { label: "Stop", value: "Ctrl-C" },
          ])}\n`,
        );
      }

      this.heartbeat = setInterval(() => {
        this.send({
          type: "local.heartbeat",
          protocolVersion: PROTOCOL_VERSION,
          frameId: `frm_${nanoid(12)}`,
          slug: this.config.slug,
          localClientId: this.localClientId,
          sessionId: this.sessionId,
          generation: this.generation,
          lastSeen: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on("message", (data) => {
      this.stats.framesReceived += 1;
      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(this.handleRelayMessage(data), {
        onExit: (exit) => {
          if (interrupt !== undefined) {
            this.activeEffects.delete(interrupt);
          }

          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }

          writeHumanSync(`! Relay message ${this.index} failed.`);
        },
      });
      this.activeEffects.add(interrupt);
    });

    ws.on("close", () => {
      this.recordRelayClose();
      if (this.heartbeat !== undefined) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }

      for (const socket of this.localWebSockets.values()) {
        socket.dispose();
      }
      this.stats.webSocketsClosed += this.localWebSockets.size;
      this.localWebSockets.clear();

      for (const interrupt of this.activeEffects) {
        interrupt();
      }
      this.activeEffects.clear();

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (cause) => {
      this.stats.relayErrors += 1;
      if (!this.stats.readyPrinted) {
        writeHumanSync(`! Relay socket ${this.index} failed to connect. ${cause.message}`);
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
    this.stats.reconnects += 1;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private handleRelayMessage(data: RawData): Effect.Effect<void> {
    const ack = (frameId: string): void => this.ack(frameId);
    const send = (frame: Frame): void => this.send(frame);
    const config = this.config;
    const localWebSockets = this.localWebSockets;
    const stats = this.stats;
    return Effect.gen(function* () {
      const parsed = parseProtocolFrameJson(
        (Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data)
        ).toString("utf8"),
      );
      if (Result.isFailure(parsed)) {
        stats.invalidFrames += 1;
        yield* Console.error(`! Discarded invalid relay frame: ${parsed.failure.reason}`);
        return;
      }

      const frame = parsed.success;
      switch (frame.type) {
        case "http.request": {
          stats.httpRequests += 1;
          ack(frame.frameId);
          const response = yield* forwardHttpToLocalAppEffect(frame, config.target);
          stats.httpResponses += 1;
          send(response);
          return;
        }

        case "ws.open": {
          stats.webSocketsOpened += 1;
          ack(frame.frameId);
          const handle = openLocalWebSocket(frame, config.target, (relayFrame) => {
            if (relayFrame.type === "ws.close") {
              if (localWebSockets.delete(relayFrame.connId)) {
                stats.webSocketsClosed += 1;
              }
            }
            send(relayFrame);
          });
          localWebSockets.set(frame.connId, handle);
          return;
        }

        case "ws.data": {
          ack(frame.frameId);
          localWebSockets.get(frame.connId)?.sendData(frame);
          return;
        }

        case "ws.close": {
          ack(frame.frameId);
          const handle = localWebSockets.get(frame.connId);
          if (handle !== undefined) {
            localWebSockets.delete(frame.connId);
            stats.webSocketsClosed += 1;
            handle.close(frame);
          }
          return;
        }

        case "error": {
          yield* Console.error(`! ${frame.message}`);
          return;
        }

        case "local.hello":
        case "local.heartbeat":
        case "delivery.ack":
        case "delivery.reject":
        case "http.response": {
          yield* Console.error(`! Discarded unexpected relay frame: ${frame.type}`);
          return;
        }
      }
    });
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.stats.framesSent += 1;
    this.ws.send(JSON.stringify(frame));
  }

  private recordRelayClose(): void {
    if (this.relayCloseRecorded) {
      return;
    }

    this.relayCloseRecorded = true;
    this.stats.relayCloses += 1;
  }

  private ack(frameId: string): void {
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "delivery.ack",
      frameId: `frm_${nanoid(12)}`,
      ackFrameId: frameId,
    });
  }
}

function relaySocketUrl(config: HttpTunnelConfig): string {
  if (config.relayUrl !== undefined) {
    const url = new URL(config.relayUrl);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }

    if (url.pathname === "") {
      url.pathname = "/";
    }

    return url.toString();
  }

  const host = tunnelHost(config);
  const hostForScheme = host.replace(/:\d+$/, "");
  const protocol =
    hostForScheme === "localhost" || hostForScheme.endsWith(".localhost") ? "ws" : "wss";
  return `${protocol}://${host}/`;
}

function relayHeaders(config: HttpTunnelConfig): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${Redacted.value(config.relaySecret)}`,
  };

  if (config.relayUrl !== undefined) {
    headers.host = tunnelHost(config);
  }

  return headers;
}

function publicTunnelUrl(config: HttpTunnelConfig): string {
  const host = tunnelHost(config);
  const hostForScheme = host.replace(/:\d+$/, "");
  const isLocalHost = hostForScheme === "localhost" || hostForScheme.endsWith(".localhost");

  if (config.relayUrl !== undefined && isLocalHost) {
    const relayUrl = new URL(config.relayUrl);
    const protocol =
      relayUrl.protocol === "wss:" || relayUrl.protocol === "https:" ? "https" : "http";
    const port = relayUrl.port === "" ? "" : `:${relayUrl.port}`;
    return `${protocol}://${hostForScheme}${port}/`;
  }

  const protocol = isLocalHost ? "http" : "https";
  return `${protocol}://${host}/`;
}

function gatewayUrl(config: HttpTunnelConfig): string {
  if (config.relayUrl !== undefined) {
    const url = new URL(config.relayUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }

    if (url.pathname === "") {
      url.pathname = "/";
    }

    return url.toString();
  }

  const host = tunnelHost(config);
  const hostForScheme = host.replace(/:\d+$/, "");
  const protocol =
    hostForScheme === "localhost" || hostForScheme.endsWith(".localhost") ? "http" : "https";
  return `${protocol}://${host}/`;
}

function tunnelHost(config: HttpTunnelConfig): string {
  if (config.relayDomain.includes("{slug}")) {
    return config.relayDomain.replaceAll("{slug}", config.slug);
  }

  return `${config.slug}.${config.relayDomain}`;
}

function printTunnelStarting(config: HttpTunnelConfig): Effect.Effect<void> {
  return writeHuman(
    `\n${bold("Starting tunnel")}\n\n${formatRows([
      { label: "Public URL", value: url(publicTunnelUrl(config)) },
      { label: "Local app", value: `http://${config.target.host}:${config.target.port}` },
      { label: "Gateway", value: gatewayUrl(config) },
    ])}\n\nConnecting relay sockets…\n`,
  );
}
