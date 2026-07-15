import { Context, Effect } from "effect";

import type { TunnelStoppedSummary } from "../cli/messages.js";
import type { HttpTunnelConfig } from "../domain/tunnel-config.js";

export type TunnelReporterShape = {
  readonly starting: (config: HttpTunnelConfig) => Effect.Effect<void>;
  readonly ready: () => Effect.Effect<void>;
  readonly stopped: (summary: TunnelStoppedSummary) => Effect.Effect<void>;
  readonly warning: (message: string) => Effect.Effect<void>;
};

export class TunnelReporter extends Context.Service<TunnelReporter, TunnelReporterShape>()(
  "turbotunnel/effect/TunnelReporter",
) {}
