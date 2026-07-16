import { Context, Effect } from "effect";

import type { LifecycleEvent } from "./lifecycle-event.js";

export class TunnelReporter extends Context.Service<
  TunnelReporter,
  { readonly emit: (event: LifecycleEvent) => Effect.Effect<void> }
>()("turbotunnel/effect/TunnelReporter") {}
