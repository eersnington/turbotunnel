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

type CallbackInterrupt = (interruptor?: number | undefined) => void;

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
  private readonly activeEffects = new Set<CallbackInterrupt>();
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

    for (const interrupt of this.activeEffects) {
      interrupt();
    }
    this.activeEffects.clear();

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
      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(this.handleRelayMessage(data), {
        onExit: (exit) => {
          if (interrupt !== undefined) {
            this.activeEffects.delete(interrupt);
          }

          if (Exit.isSuccess(exit)) {
            return;
          }

          console.error(kleur.yellow(`relay message ${this.index} failed.`));
        },
      });
      this.activeEffects.add(interrupt);
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

      for (const interrupt of this.activeEffects) {
        interrupt();
      }
      this.activeEffects.clear();

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
      const parsed = parseProtocolFrameJson(
        (Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data)
        ).toString("utf8"),
      );
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

function tunnelHost(config: HttpTunnelConfig): string {
  if (config.relayDomain.includes("{slug}")) {
    return config.relayDomain.replaceAll("{slug}", config.slug);
  }

  return `${config.slug}.${config.relayDomain}`;
}

function printTunnelReady(config: HttpTunnelConfig): Effect.Effect<void> {
  return Console.log(
    `\n${kleur.bold("Tunnel ready:")}\n\n  ${kleur.cyan(publicTunnelUrl(config))}\n    ${kleur.dim("->")} http://${config.target.host}:${config.target.port}\n`,
  );
}
