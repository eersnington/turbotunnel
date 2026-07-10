import {
  type Frame,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_CLIENT_CAPACITY,
  LOCAL_CLIENT_SUBPROTOCOL,
  parseProtocolFrameJson,
  PROTOCOL_VERSION,
} from "@turbotunnel/protocol";
import { Cause, Console, Effect, Exit, Result } from "effect";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";

import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import { relayHeaders, relaySocketUrl } from "../domain/tunnel-url.js";
import type { TunnelReporter } from "../adapters/tunnel-runtime.js";
import { forwardHttpToLocalApp } from "./forward-http.js";
import { type LocalWebSocketHandle, openLocalWebSocket } from "./forward-ws.js";

export type TunnelSessionStats = {
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

type CallbackInterrupt = (interruptor?: number | undefined) => void;

export class RelayConnection {
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
    private readonly reporter: TunnelReporter,
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
    const ws = new WebSocket(relaySocketUrl(this.config), LOCAL_CLIENT_SUBPROTOCOL, {
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
        Effect.runSync(this.reporter.ready());
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

    // `ws` emits complete text messages as Buffer in its default nodebuffer mode.
    ws.on("message", (data: Buffer, isBinary) => {
      this.stats.framesReceived += 1;
      if (isBinary) {
        this.stats.invalidFrames += 1;
        Effect.runSync(Console.error("! Discarded invalid relay frame: relay sent a binary WebSocket message."));
        return;
      }

      let interrupt: CallbackInterrupt | undefined;
      interrupt = Effect.runCallback(this.handleRelayMessage(data.toString("utf8")), {
        onExit: (exit) => {
          if (interrupt !== undefined) {
            this.activeEffects.delete(interrupt);
          }
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }

          Effect.runSync(this.reporter.warning(`! Relay message ${this.index} failed.`));
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
        Effect.runSync(
          this.reporter.warning(`! Relay socket ${this.index} failed to connect. ${cause.message}`),
        );
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
    this.stats.reconnects += 1;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleRelayMessage(text: string): Effect.Effect<void> {
    const ack = (frameId: string): void => this.ack(frameId);
    const send = (frame: Frame): void => this.send(frame);
    const config = this.config;
    const localWebSockets = this.localWebSockets;
    const stats = this.stats;
    return Effect.gen(function* () {
      const parsed = parseProtocolFrameJson(text);
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
          const response = yield* forwardHttpToLocalApp(frame, config.target);
          stats.httpResponses += 1;
          send(response);
          return;
        }
        case "ws.open": {
          stats.webSocketsOpened += 1;
          ack(frame.frameId);
          const handle = openLocalWebSocket(frame, config.target, (relayFrame) => {
            if (relayFrame.type === "ws.close" && localWebSockets.delete(relayFrame.connId)) {
              stats.webSocketsClosed += 1;
            }
            send(relayFrame);
          });
          if (handle !== undefined) {
            localWebSockets.set(frame.connId, handle);
          }
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

  private ack(frameId: string): void {
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "delivery.ack",
      frameId: `frm_${nanoid(12)}`,
      ackFrameId: frameId,
    });
  }

  private recordRelayClose(): void {
    if (!this.relayCloseRecorded) {
      this.relayCloseRecorded = true;
      this.stats.relayCloses += 1;
    }
  }
}
