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
import { TunnelReporter } from "../runtime/tunnel-reporter.js";

export const startHttpTunnel = Effect.fn("startHttpTunnel")(function* (
  input: HttpCommandInput,
  env: TunnelEnvironment,
): Effect.fn.Return<
  never,
  StartHttpTunnelError,
  Entropy | LocalConfigStore | LocalAppProbe | TunnelRuntime | TunnelReporter
> {
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const localAppProbe = yield* LocalAppProbe;
  const tunnelRuntime = yield* TunnelRuntime;
  const reporter = yield* TunnelReporter;
  const savedConfig = yield* localConfigStore.read;
  const config = yield* resolveTunnelConfig({
    input,
    env,
    savedConfig,
    generatedSlug: yield* entropy.tunnelSlug,
  });
  yield* reporter.emit({
    _tag: "TunnelStarting",
    config,
    launch: { _tag: "ExistingApplication" },
  });
  yield* reporter.emit({ _tag: "LocalApplicationWaiting", target: config.target });
  yield* localAppProbe.assertReachable(config.target);
  return yield* tunnelRuntime.run(config);
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
