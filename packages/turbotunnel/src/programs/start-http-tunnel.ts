import { Effect } from "effect";

import { Entropy } from "../adapters/entropy.js";
import { LocalAppProbe } from "../adapters/local-app-probe.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import {
  type HttpCommandInput,
  type TunnelEnvironment,
  resolveTunnelConfig,
} from "../domain/tunnel-config.js";
import type { StartHttpTunnelError } from "../errors.js";

export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  input: HttpCommandInput,
  env: TunnelEnvironment,
): Effect.fn.Return<
  never,
  StartHttpTunnelError,
  Entropy | LocalConfigStore | LocalAppProbe | TunnelRuntime
> {
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const localAppProbe = yield* LocalAppProbe;
  const tunnelRuntime = yield* TunnelRuntime;
  const savedConfig = yield* localConfigStore.read;
  const resolved = resolveTunnelConfig({
    input,
    env,
    savedConfig,
    generatedSlug: yield* entropy.tunnelSlug,
  });
  if (resolved._tag === "err") {
    return yield* resolved.error;
  }

  yield* localAppProbe.assertReachable(resolved.config.target);
  return yield* tunnelRuntime.run(resolved.config);
});

export function tunnelEnvironmentFromProcess(env: NodeJS.ProcessEnv): TunnelEnvironment {
  return {
    TURBOTUNNEL_SLUG: env.TURBOTUNNEL_SLUG,
    TURBOTUNNEL_BASE_DOMAIN: env.TURBOTUNNEL_BASE_DOMAIN,
    TURBOTUNNEL_RELAY_DOMAIN: env.TURBOTUNNEL_RELAY_DOMAIN,
    TURBOTUNNEL_RELAY_SECRET: env.TURBOTUNNEL_RELAY_SECRET,
    TURBOTUNNEL_RELAY_URL: env.TURBOTUNNEL_RELAY_URL,
  };
}
