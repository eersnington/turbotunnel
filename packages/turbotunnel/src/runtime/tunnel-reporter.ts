import { Context, Effect } from "effect";

import type { LifecycleEvent } from "./lifecycle-event.js";

export type TunnelReporterShape = {
  readonly emit: (event: LifecycleEvent) => Effect.Effect<void>;
};

export class TunnelReporter extends Context.Service<TunnelReporter, TunnelReporterShape>()(
  "turbotunnel/effect/TunnelReporter",
) {}
