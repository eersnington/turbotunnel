import type { HttpTunnelConfig, LocalTarget } from "../domain/tunnel-config.js";

export type TunnelStoppedSummary = {
  readonly wasReady: boolean;
  readonly durationSeconds: number;
  readonly httpRequests: number;
  readonly webSocketsOpened: number;
};

export type RecoverableWarning = {
  readonly failure: string;
  readonly attemptedRecovery: string;
  readonly impact: string;
};

export type LifecycleEvent =
  | { readonly _tag: "DevelopmentProcessStarting"; readonly command: string }
  | { readonly _tag: "DevelopmentProcessStarted" }
  | { readonly _tag: "LocalApplicationWaiting"; readonly target: LocalTarget }
  | { readonly _tag: "RelaysConnecting"; readonly config: HttpTunnelConfig }
  | {
      readonly _tag: "TunnelReady";
      readonly config: HttpTunnelConfig;
      readonly readyAfterMs: number;
    }
  | {
      readonly _tag: "RelayDisconnected";
      readonly connectedRelays: number;
      readonly configuredRelays: number;
    }
  | {
      readonly _tag: "RelayReconnecting";
      readonly slot: number;
      readonly attempt: number;
      readonly retryInMs: number;
    }
  | { readonly _tag: "RelayRestored"; readonly disconnectedForMs: number }
  | { readonly _tag: "RecoverableWarning"; readonly warning: RecoverableWarning }
  | { readonly _tag: "Stopping" }
  | { readonly _tag: "TunnelStopped"; readonly summary: TunnelStoppedSummary }
  | { readonly _tag: "UnrecoverableFailure"; readonly reason: string };
