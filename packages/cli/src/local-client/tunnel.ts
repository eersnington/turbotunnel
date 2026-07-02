import { Buffer } from "node:buffer";

import {
  type Frame,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_CLIENT_SUBPROTOCOL,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
} from "@repo/turbotunnel-protocol";
import { Console, Effect, Exit, Redacted, Result } from "effect";
import kleur from "kleur";
import { nanoid } from "nanoid";
import { WebSocket, type RawData } from "ws";

import type { HttpTunnelConfig } from "../config.js";
import { forwardHttpToLocalAppEffect } from "./forward-http.js";
import { type LocalWebSocketHandle, openLocalWebSocket } from "./forward-ws.js";

/** Start a local tunnel process and keep it alive until interrupted. */
export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  config: HttpTunnelConfig,
): Effect.fn.Return<never, never, never> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* printTunnelReady(config);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const connections: Array<RelayConnection> = [];
          for (let index = 0; index < config.poolSize; index += 1) {
            const connection = new RelayConnection(config, index);
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
  private stopped = false;
  private localClientId = "";
  private readonly localWebSockets = new Map<string, LocalWebSocketHandle>();

  constructor(
    private readonly config: HttpTunnelConfig,
    private readonly index: number,
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

    for (const socket of this.localWebSockets.values()) {
      socket.dispose();
    }

    this.localWebSockets.clear();
    this.ws?.close(1001, "turbotunnel process stopped");
  }

  private connect(): void {
    this.localClientId = `client_${nanoid(12)}`;
    const url = relaySocketUrl(this.config);
    const ws = new WebSocket(url, LOCAL_CLIENT_SUBPROTOCOL, {
      headers: relayHeaders(this.config),
    });

    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = 1_000;
      this.send({
        type: "local.hello",
        protocolVersion: PROTOCOL_VERSION,
        frameId: `frm_${nanoid(12)}`,
        slug: this.config.slug,
        localClientId: this.localClientId,
        target: this.config.target,
      });

      this.heartbeat = setInterval(() => {
        this.send({
          type: "local.heartbeat",
          protocolVersion: PROTOCOL_VERSION,
          frameId: `frm_${nanoid(12)}`,
          slug: this.config.slug,
          localClientId: this.localClientId,
          lastSeen: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on("message", (data) => {
      observeEffect(this.handleRelayMessage(data), `relay message ${this.index}`);
    });

    ws.on("close", () => {
      if (this.heartbeat !== undefined) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }

      for (const socket of this.localWebSockets.values()) {
        socket.dispose();
      }
      this.localWebSockets.clear();

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (cause) => {
      console.error(kleur.yellow(`relay socket ${this.index} error: ${cause.message}`));
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
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
    return Effect.gen(function* () {
      const text = rawDataToText(data);
      const parsed = parseProtocolFrameJson(text);
      if (Result.isFailure(parsed)) {
        yield* Console.error(
          kleur.yellow(`discarded invalid relay frame: ${parsed.failure.reason}`),
        );
        return;
      }

      const frame = parsed.success;
      switch (frame.type) {
        case "http.request": {
          ack(frame.frameId);
          const response = yield* forwardHttpToLocalAppEffect(frame, config.target);
          send(response);
          return;
        }

        case "ws.open": {
          ack(frame.frameId);
          const handle = openLocalWebSocket(frame, config.target, (relayFrame) => {
            if (relayFrame.type === "ws.close") {
              localWebSockets.delete(relayFrame.connId);
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
            handle.close(frame);
          }
          return;
        }

        case "error": {
          yield* Console.error(kleur.yellow(frame.message));
          return;
        }

        case "local.hello":
        case "local.heartbeat":
        case "delivery.ack":
        case "delivery.reject":
        case "http.response": {
          yield* Console.error(kleur.yellow(`discarded unexpected relay frame: ${frame.type}`));
          return;
        }
      }
    });
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(frame));
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

  return `wss://${tunnelHost(config)}/`;
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
  const relayDomainHost = config.relayDomain.replace(/:\d+$/, "");

  if (config.relayUrl !== undefined && relayDomainHost === "localhost") {
    const relayUrl = new URL(config.relayUrl);
    const protocol =
      relayUrl.protocol === "wss:" || relayUrl.protocol === "https:" ? "https" : "http";
    const port = relayUrl.port === "" ? "" : `:${relayUrl.port}`;
    return `${protocol}://${tunnelHost(config)}${port}/`;
  }

  const protocol = relayDomainHost === "localhost" ? "http" : "https";
  return `${protocol}://${tunnelHost(config)}/`;
}

function tunnelHost(config: HttpTunnelConfig): string {
  if (config.relayDomain.includes("{slug}")) {
    return config.relayDomain.replaceAll("{slug}", config.slug);
  }

  return `${config.slug}.${config.relayDomain}`;
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return Buffer.concat(data).toString("utf8");
}

function printTunnelReady(config: HttpTunnelConfig): Effect.Effect<void> {
  return Console.log(
    `\n${kleur.bold("Tunnel ready:")}\n\n  ${kleur.cyan(publicTunnelUrl(config))}\n    ${kleur.dim("->")} http://${config.target.host}:${config.target.port}\n`,
  );
}

function observeEffect(effect: Effect.Effect<unknown>, operation: string): void {
  Effect.runCallback(effect, {
    onExit(exit) {
      if (Exit.isSuccess(exit)) {
        return;
      }

      console.error(kleur.yellow(`${operation} failed.`));
    },
  });
}
