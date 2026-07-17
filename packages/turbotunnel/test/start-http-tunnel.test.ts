import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { Entropy } from "../src/adapters/entropy.js";
import { GatewayStatusChecker } from "../src/adapters/gateway-status-checker.js";
import { LocalAppProbe } from "../src/adapters/local-app-probe.js";
import { LocalConfigStore } from "../src/adapters/local-config-store.js";
import { ProjectConfigStore } from "../src/adapters/project-config-store.js";
import { ProjectDomain } from "../src/adapters/project-domain.js";
import { TunnelRuntime } from "../src/adapters/tunnel-runtime.js";
import type { HttpTunnelConfig, LocalTarget } from "../src/domain/tunnel-config.js";
import { LocalTargetNotReachable } from "../src/errors.js";
import { startHttpTunnel } from "../src/programs/start-http-tunnel.js";
import { TunnelReporter } from "../src/runtime/tunnel-reporter.js";

describe("startHttpTunnel", () => {
  it.effect("starts the tunnel without requiring the local app to be reachable", () =>
    Effect.gen(function* () {
      const recorder = new TunnelRecorder();

      yield* startHttpTunnel({ port: 5173, host: "localhost" }, {}).pipe(
        Effect.provide(recorder.layer()),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      expect(recorder.probedTarget).toBeUndefined();
      expect(recorder.startedConfig?.slug).toBe("demo");
      expect(recorder.startedConfig?.relayDomain).toBe("tunnel.example.com");
      expect(recorder.events[0]).toMatchObject({
        _tag: "TunnelStarting",
        launch: { _tag: "ExistingApplication" },
        config: { target: { host: "localhost", port: 5173 } },
      });
    }),
  );

  it.effect("fails before runtime when no gateway is configured", () =>
    Effect.gen(function* () {
      const recorder = new TunnelRecorder({ savedGateway: false });

      const exit = yield* startHttpTunnel({ port: 5173, host: "localhost" }, {}).pipe(
        Effect.provide(recorder.layer()),
        Effect.exit,
      );

      expect(exit._tag).toBe("Failure");
      expect(recorder.probedTarget).toBeUndefined();
      expect(recorder.startedConfig).toBeUndefined();
    }),
  );

  it.effect("starts the runtime when the local app probe would fail", () =>
    Effect.gen(function* () {
      const recorder = new TunnelRecorder();
      recorder.failProbe = true;

      yield* startHttpTunnel({ port: 5173, host: "localhost" }, {}).pipe(
        Effect.provide(recorder.layer()),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      expect(recorder.probedTarget).toBeUndefined();
      expect(recorder.startedConfig?.target).toEqual({
        protocol: "http",
        host: "localhost",
        port: 5173,
      });
    }),
  );
});

class TunnelRecorder {
  probedTarget: LocalTarget | undefined;
  startedConfig: HttpTunnelConfig | undefined;
  readonly events: Array<Parameters<TunnelReporter["Service"]["emit"]>[0]> = [];
  failProbe = false;

  constructor(private readonly options: { readonly savedGateway?: boolean } = {}) {}

  layer() {
    const savedGateway = this.options.savedGateway !== false;
    return Layer.mergeAll(
      Layer.succeed(
        ProjectConfigStore,
        ProjectConfigStore.of({ discover: () => Effect.succeed(undefined) }),
      ),
      Layer.succeed(
        ProjectDomain,
        ProjectDomain.of({ reconcile: () => Effect.die("unexpected domain reconciliation") }),
      ),
      Layer.succeed(
        GatewayStatusChecker,
        GatewayStatusChecker.of({
          check: (url) => Effect.succeed({ url, status: "unreachable" }),
        }),
      ),
      Layer.succeed(
        Entropy,
        Entropy.of({
          deploySlug: Effect.succeed("deploy1"),
          tunnelSlug: Effect.succeed("local1"),
          relaySecret: Effect.succeed(Redacted.make("secret", { label: "relay-secret" })),
        }),
      ),
      Layer.succeed(
        LocalConfigStore,
        LocalConfigStore.of({
          read: Effect.succeed(
            savedGateway
              ? { slug: "demo", relayDomain: "tunnel.example.com", relaySecret: "saved_secret" }
              : {},
          ),
          write: () => Effect.void,
        }),
      ),
      Layer.succeed(
        LocalAppProbe,
        LocalAppProbe.of({
          assertReachable: (target) =>
            this.failProbe
              ? Effect.fail(
                  new LocalTargetNotReachable({
                    host: target.host,
                    port: target.port,
                    cause: "test",
                    message: "probe failed",
                  }),
                )
              : Effect.sync(() => {
                  this.probedTarget = target;
                }),
          waitUntilReachable: (target) =>
            Effect.sync(() => {
              this.probedTarget = target;
            }),
        }),
      ),
      Layer.succeed(
        TunnelRuntime,
        TunnelRuntime.of({
          run: (config) =>
            Effect.sync(() => {
              this.startedConfig = config;
            }).pipe(Effect.andThen(Effect.never)),
        }),
      ),
      Layer.succeed(
        TunnelReporter,
        TunnelReporter.of({ emit: (event) => Effect.sync(() => this.events.push(event)) }),
      ),
    );
  }
}
