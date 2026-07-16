import { Effect } from "effect";

import { DevProcess } from "../adapters/dev-process.js";
import { Entropy } from "../adapters/entropy.js";
import { LocalAppProbe } from "../adapters/local-app-probe.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { PortAllocator } from "../adapters/port-allocator.js";
import { ProjectDiscovery } from "../adapters/project-discovery.js";
import { TunnelRuntime } from "../adapters/tunnel-runtime.js";
import {
  customCommandPort,
  type DevCommandInput,
  resolveDevLaunch,
} from "../domain/dev-project.js";
import { resolveTunnelConfig, type TunnelEnvironment } from "../domain/tunnel-config.js";
import { publicTunnelUrl } from "../domain/tunnel-url.js";
import { DevServerReadinessTimeout, type StartDevError } from "../errors.js";

const DEV_SERVER_READINESS_TIMEOUT_SECONDS = 60;

export const startDev = Effect.fn("startDev")(function* (options: {
  readonly input: DevCommandInput;
  readonly cwd: string;
  readonly env: TunnelEnvironment;
}): Effect.fn.Return<
  number,
  StartDevError,
  | ProjectDiscovery
  | PortAllocator
  | DevProcess
  | Entropy
  | LocalConfigStore
  | LocalAppProbe
  | TunnelRuntime
> {
  const projectDiscovery = yield* ProjectDiscovery;
  const portAllocator = yield* PortAllocator;
  const devProcess = yield* DevProcess;
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const localAppProbe = yield* LocalAppProbe;
  const tunnelRuntime = yield* TunnelRuntime;

  const project = yield* projectDiscovery.discover(options.cwd);
  const customPort =
    options.input.port === undefined ? yield* customCommandPort(options.input.command) : undefined;
  const port = options.input.port ?? customPort ?? (yield* portAllocator.freePort);
  const launch = yield* resolveDevLaunch(project, options.input, port);
  const config = yield* resolveTunnelConfig({
    input: { port, host: "localhost" },
    env: options.env,
    savedConfig: yield* localConfigStore.read,
    generatedSlug: yield* entropy.tunnelSlug,
  });
  const publicUrl = publicTunnelUrl(config);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* devProcess.spawn({
        executable: launch.executable,
        args: launch.args,
        cwd: project.root,
        env: {
          PORT: String(port),
          TURBOTUNNEL_URL: publicUrl,
          TURBOTUNNEL_HOST: new URL(publicUrl).host,
          TURBOTUNNEL_SLUG: config.slug,
        },
      });
      const childExit = child.exitCode.pipe(
        Effect.map((exitCode) => ({ _tag: "Exited" as const, exitCode })),
      );
      const readiness = localAppProbe.waitUntilReachable(config.target).pipe(
        Effect.timeoutOrElse({
          duration: `${DEV_SERVER_READINESS_TIMEOUT_SECONDS} seconds`,
          orElse: () =>
            Effect.fail(
              new DevServerReadinessTimeout({
                host: config.target.host,
                port: config.target.port,
                timeoutSeconds: DEV_SERVER_READINESS_TIMEOUT_SECONDS,
                message: `Dev server did not become reachable at http://${config.target.host}:${config.target.port} within ${DEV_SERVER_READINESS_TIMEOUT_SECONDS} seconds. Check the child output and its host/port settings, then retry. The child process and tunnel were stopped.`,
              }),
            ),
        }),
        Effect.as({ _tag: "Ready" as const }),
      );
      const first = yield* Effect.raceFirst(readiness, childExit);
      if (first._tag === "Exited") return first.exitCode;

      return yield* Effect.raceFirst(tunnelRuntime.run(config), child.exitCode);
    }),
  );
});
