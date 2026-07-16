import { Effect, SynchronizedRef } from "effect";

import type { HttpTunnelConfig } from "../domain/tunnel-config.js";
import type { TunnelLifecycleSnapshot } from "../domain/tunnel-lifecycle.js";
import { gatewayUrl, publicTunnelUrl } from "../domain/tunnel-url.js";
import type { LifecycleEvent, TunnelStoppedSummary } from "./lifecycle-event.js";
import type { TunnelReporter } from "./tunnel-reporter.js";

type TunnelCounters = {
  readonly relayConnects: number;
  readonly relayCloses: number;
  readonly relayErrors: number;
  readonly reconnects: number;
  readonly framesReceived: number;
  readonly framesSent: number;
  readonly invalidFrames: number;
  readonly httpRequests: number;
  readonly httpResponses: number;
  readonly webSocketsOpened: number;
  readonly webSocketsClosed: number;
};

type TunnelSessionState = {
  readonly relayWorkersStarted: boolean;
  readonly relays: ReadonlyArray<boolean>;
  readonly reachedConfiguredPool: boolean;
  readonly disconnectedAtMs?: number;
  readonly initialWarningSlots: ReadonlySet<number>;
  readonly invalidFrameWarningEmitted: boolean;
  readonly counters: TunnelCounters;
};

export type TunnelSession = {
  readonly relayWorkersStarted: Effect.Effect<void>;
  readonly relayConnected: (slot: number, nowMs: number) => Effect.Effect<void>;
  readonly relayClosed: (options: {
    readonly slot: number;
    readonly nowMs: number;
    readonly failure?: string;
  }) => Effect.Effect<void>;
  readonly relayReconnecting: Effect.Effect<void>;
  readonly recordFrameReceived: Effect.Effect<void>;
  readonly recordFrameSent: Effect.Effect<void>;
  readonly recordInvalidFrame: Effect.Effect<boolean>;
  readonly recordHttpRequest: Effect.Effect<void>;
  readonly recordHttpResponse: Effect.Effect<void>;
  readonly recordWebSocketOpened: Effect.Effect<void>;
  readonly recordWebSocketsClosed: (count: number) => Effect.Effect<void>;
  readonly snapshot: () => TunnelLifecycleSnapshot;
  readonly stoppedSummary: (stoppedAtMs: number) => TunnelStoppedSummary;
};

export const makeTunnelSession = Effect.fn("TunnelSession.make")(function* (options: {
  readonly config: HttpTunnelConfig;
  readonly sessionId: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly reporter: TunnelReporter["Service"];
}) {
  const state = yield* SynchronizedRef.make<TunnelSessionState>({
    relayWorkersStarted: false,
    relays: Array.from({ length: options.config.poolSize }, () => false),
    reachedConfiguredPool: false,
    initialWarningSlots: new Set(),
    invalidFrameWarningEmitted: false,
    counters: emptyCounters,
  });

  const transition = (
    reduce: (current: TunnelSessionState) => {
      readonly state: TunnelSessionState;
      readonly events?: ReadonlyArray<LifecycleEvent>;
    },
  ) =>
    SynchronizedRef.modifyEffect(state, (current) => {
      const result = reduce(current);
      return Effect.forEach(result.events ?? [], options.reporter.emit, { discard: true }).pipe(
        Effect.as([undefined, result.state] as const),
      );
    });

  const updateCounters = (update: (counters: TunnelCounters) => TunnelCounters) =>
    transition((current) => ({
      state: { ...current, counters: update(current.counters) },
    }));

  const snapshot = (): TunnelLifecycleSnapshot =>
    makeSnapshot(options, SynchronizedRef.getUnsafe(state));

  return {
    relayWorkersStarted: transition((current) => ({
      state: { ...current, relayWorkersStarted: true },
    })),
    relayConnected: (slot, nowMs) =>
      transition((current) => {
        if (current.relays[slot]) return { state: current };
        const relays = replaceRelay(current.relays, slot, true);
        const connectedRelays = countConnected(relays);
        const fullPool = connectedRelays === options.config.poolSize;
        const events: Array<LifecycleEvent> = [];
        if (fullPool && current.disconnectedAtMs !== undefined) {
          events.push({
            _tag: "RelayRestored",
            disconnectedForMs: Math.max(0, nowMs - current.disconnectedAtMs),
          });
        } else if (fullPool && !current.reachedConfiguredPool) {
          events.push({
            _tag: "TunnelReady",
            config: options.config,
            readyAfterMs: Math.max(0, nowMs - options.startedAtMs),
          });
        }
        return {
          state: {
            ...current,
            relays,
            reachedConfiguredPool: current.reachedConfiguredPool || fullPool,
            disconnectedAtMs: fullPool ? undefined : current.disconnectedAtMs,
            counters: {
              ...current.counters,
              relayConnects: current.counters.relayConnects + 1,
            },
          },
          events,
        };
      }),
    relayClosed: ({ slot, nowMs, failure }) =>
      transition((current) => {
        const wasConnected = current.relays[slot] === true;
        const relays = wasConnected ? replaceRelay(current.relays, slot, false) : current.relays;
        const disconnectedAtMs =
          current.reachedConfiguredPool && wasConnected
            ? (current.disconnectedAtMs ?? nowMs)
            : current.disconnectedAtMs;
        const events: Array<LifecycleEvent> = [];
        let initialWarningSlots = current.initialWarningSlots;
        if (
          failure !== undefined &&
          !current.reachedConfiguredPool &&
          !current.initialWarningSlots.has(slot)
        ) {
          initialWarningSlots = new Set(current.initialWarningSlots).add(slot);
          events.push({
            _tag: "RecoverableWarning",
            warning: {
              failure: `Relay socket ${slot + 1} failed to connect: ${failure}`,
              attemptedRecovery: "Turbotunnel will retry automatically.",
              impact: "The tunnel is not ready yet; the local application remains running.",
            },
          });
        }

        return {
          state: {
            ...current,
            relays,
            disconnectedAtMs,
            initialWarningSlots,
            counters: {
              ...current.counters,
              relayCloses: current.counters.relayCloses + 1,
              relayErrors: current.counters.relayErrors + (failure === undefined ? 0 : 1),
              reconnects: current.counters.reconnects + 1,
            },
          },
          events,
        };
      }),
    relayReconnecting: transition((current) => ({
      state: current,
      events: current.reachedConfiguredPool ? [{ _tag: "RelayReconnecting" }] : [],
    })),
    recordFrameReceived: updateCounters((counters) => ({
      ...counters,
      framesReceived: counters.framesReceived + 1,
    })),
    recordFrameSent: updateCounters((counters) => ({
      ...counters,
      framesSent: counters.framesSent + 1,
    })),
    recordInvalidFrame: SynchronizedRef.modify(state, (current) => [
      !current.invalidFrameWarningEmitted,
      {
        ...current,
        invalidFrameWarningEmitted: true,
        counters: {
          ...current.counters,
          invalidFrames: current.counters.invalidFrames + 1,
        },
      },
    ]),
    recordHttpRequest: updateCounters((counters) => ({
      ...counters,
      httpRequests: counters.httpRequests + 1,
    })),
    recordHttpResponse: updateCounters((counters) => ({
      ...counters,
      httpResponses: counters.httpResponses + 1,
    })),
    recordWebSocketOpened: updateCounters((counters) => ({
      ...counters,
      webSocketsOpened: counters.webSocketsOpened + 1,
    })),
    recordWebSocketsClosed: (count) =>
      updateCounters((counters) => ({
        ...counters,
        webSocketsClosed: counters.webSocketsClosed + count,
      })),
    snapshot,
    stoppedSummary: (stoppedAtMs) => {
      const current = SynchronizedRef.getUnsafe(state);
      return {
        wasReady: current.reachedConfiguredPool,
        durationSeconds: Math.max(0, Math.round((stoppedAtMs - options.startedAtMs) / 1_000)),
        httpRequests: current.counters.httpRequests,
        webSocketsOpened: current.counters.webSocketsOpened,
      };
    },
  } satisfies TunnelSession;
});

const emptyCounters: TunnelCounters = {
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
};

function replaceRelay(relays: ReadonlyArray<boolean>, slot: number, connected: boolean) {
  return relays.map((value, index) => (index === slot ? connected : value));
}

function countConnected(relays: ReadonlyArray<boolean>): number {
  return relays.reduce((count, connected) => count + Number(connected), 0);
}

function makeSnapshot(
  options: {
    readonly config: HttpTunnelConfig;
    readonly sessionId: string;
    readonly pid: number;
    readonly startedAtMs: number;
  },
  state: TunnelSessionState,
): TunnelLifecycleSnapshot {
  const connectedRelays = countConnected(state.relays);
  const gateway = gatewayUrl(options.config);
  return {
    version: 1,
    sessionId: options.sessionId,
    pid: options.pid,
    state: !state.relayWorkersStarted
      ? "starting"
      : connectedRelays === options.config.poolSize
        ? "ready"
        : state.reachedConfiguredPool
          ? "reconnecting"
          : "connecting",
    startedAtMs: options.startedAtMs,
    publicUrl: publicTunnelUrl(options.config),
    localUrl: `http://${options.config.target.host}:${options.config.target.port}`,
    gatewayStatusUrl:
      options.config.relayUrl === undefined
        ? `${gateway.replace(/\/$/u, "")}/_turbotunnel/status`
        : new URL("/_turbotunnel/status", gateway).toString(),
    configuredRelays: options.config.poolSize,
    connectedRelays,
    ...state.counters,
  };
}
