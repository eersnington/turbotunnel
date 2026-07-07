import { Context, Effect, Layer } from "effect";

import type { LocalTarget } from "../domain/tunnel-config.js";
import { LocalTargetNotReachable } from "../errors.js";

export type LocalAppProbeShape = {
  readonly assertReachable: (target: LocalTarget) => Effect.Effect<void, LocalTargetNotReachable>;
};

export class LocalAppProbe extends Context.Service<LocalAppProbe, LocalAppProbeShape>()(
  "turbotunnel/effect/LocalAppProbe",
) {
  static readonly live = Layer.succeed(this, this.of({ assertReachable }));
}

const LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS = 3_000;

function assertReachable(target: LocalTarget): Effect.Effect<void, LocalTargetNotReachable> {
  return Effect.tryPromise({
    try: (signal) => globalThis.fetch(`http://${target.host}:${target.port}/`, { signal }),
    catch: (cause) =>
      new LocalTargetNotReachable({
        host: target.host,
        port: target.port,
        cause,
        message: `Local app is not reachable at http://${target.host}:${target.port}. Start the app first, or pass --host if it is listening on a different interface. No tunnel was started.`,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new LocalTargetNotReachable({
            host: target.host,
            port: target.port,
            cause: { timeoutMs: LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS },
            message: `Local app is not reachable at http://${target.host}:${target.port}. Start the app first, or pass --host if it is listening on a different interface. No tunnel was started.`,
          }),
        ),
    }),
    Effect.asVoid,
  );
}
