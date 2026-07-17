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

export type TunnelLaunch =
  | { readonly _tag: "ExistingApplication" }
  | {
      readonly _tag: "ManagedProcess";
      readonly command: string;
      readonly directory: string;
    };

export type LifecycleEvent =
  | { readonly _tag: "DomainConfiguring"; readonly hostname: string }
  | {
      readonly _tag: "TunnelStarting";
      readonly config: HttpTunnelConfig;
      readonly launch: TunnelLaunch;
    }
  | { readonly _tag: "LocalApplicationWaiting"; readonly target: LocalTarget }
  | { readonly _tag: "LocalApplicationReady" }
  | { readonly _tag: "DevelopmentOutputStarting" }
  | { readonly _tag: "RelaysConnecting"; readonly configuredRelays: number }
  | {
      readonly _tag: "TunnelReady";
      readonly readyAfterMs: number;
    }
  | { readonly _tag: "RelayReconnecting" }
  | { readonly _tag: "RelayRestored"; readonly disconnectedForMs: number }
  | { readonly _tag: "RecoverableWarning"; readonly warning: RecoverableWarning }
  | { readonly _tag: "TunnelStopped"; readonly summary: TunnelStoppedSummary }
  | { readonly _tag: "UnrecoverableFailure" };
