import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";

import { DevProcess } from "../src/adapters/dev-process.js";
import { Entropy } from "../src/adapters/entropy.js";
import { GatewayStatusChecker } from "../src/adapters/gateway-status-checker.js";
import { LocalConfigStore } from "../src/adapters/local-config-store.js";
import { ProjectConfigStore } from "../src/adapters/project-config-store.js";
import { ProjectDomain } from "../src/adapters/project-domain.js";
import { TunnelRuntime } from "../src/adapters/tunnel-runtime.js";
import type { HttpTunnelConfig } from "../src/domain/tunnel-config.js";
import { startDev } from "../src/programs/start-dev.js";
import { TunnelReporter } from "../src/runtime/tunnel-reporter.js";
import type { LifecycleEvent } from "../src/runtime/lifecycle-event.js";

describe("startDev", () => {
  it.effect("runs the exact child command from the invocation directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-dev-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const realRoot = yield* Effect.promise(() => realpath(root));
        const outputPath = join(root, "child.json");
        const events: Array<LifecycleEvent> = [];
        const script =
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), injected: { PORT: process.env.PORT, URL: process.env.TURBOTUNNEL_URL } })); process.exit(19)";

        const exitCode = yield* startDev({
          input: {
            port: 5173,
            command: [process.execPath, "-e", script, outputPath, "--api-key", "secret"],
          },
          cwd: realRoot,
        }).pipe(Effect.provide(makeTestLayer(events)), Effect.provide(NodeServices.layer));

        expect(exitCode).toBe(19);
        expect(JSON.parse(yield* Effect.promise(() => readFile(outputPath, "utf8")))).toEqual({
          cwd: realRoot,
          argv: ["--api-key", "secret"],
          injected: {},
        });
        expect(events[0]).toMatchObject({
          _tag: "TunnelStarting",
          launch: {
            _tag: "ManagedProcess",
            directory: realRoot,
          },
        });
        const event = events[0];
        if (event?._tag === "TunnelStarting" && event.launch._tag === "ManagedProcess") {
          expect(event.launch.command).toContain(`${process.execPath} -e`);
          expect(event.launch.command).toContain("--api-key <redacted>");
          expect(event.launch.command).not.toContain("--api-key secret");
        }
      }),
    ),
  );

  it.effect("opens the tunnel without spawning a child when no command is supplied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-dev-tunnel-only-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const started = yield* Deferred.make<HttpTunnelConfig>();
        const events: Array<LifecycleEvent> = [];
        const running = startDev({
          input: { port: 4173, command: [] },
          cwd: root,
        }).pipe(
          Effect.provide(
            makeTestLayer(events, {
              devProcess: DevProcess.of({ spawn: () => Effect.die("unexpected child spawn") }),
              tunnelRuntime: TunnelRuntime.of({
                run: (config) =>
                  Deferred.succeed(started, config).pipe(Effect.andThen(Effect.never)),
              }),
            }),
          ),
          Effect.provide(NodeServices.layer),
        );

        const fiber = yield* Effect.forkChild(running);
        const config = yield* Deferred.await(started);

        expect(config.target).toEqual({ protocol: "http", host: "localhost", port: 4173 });
        expect(events).toContainEqual(
          expect.objectContaining({
            _tag: "TunnelStarting",
            launch: { _tag: "ExistingApplication" },
          }),
        );
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});

const makeTestLayer = (
  events: Array<LifecycleEvent>,
  options?: {
    readonly devProcess?: DevProcess["Service"];
    readonly tunnelRuntime?: TunnelRuntime["Service"];
  },
) =>
  Layer.mergeAll(
    ProjectConfigStore.live,
    Layer.succeed(
      ProjectDomain,
      ProjectDomain.of({ reconcile: () => Effect.die("unexpected domain reconciliation") }),
    ),
    gatewayStatusLayer,
    options?.devProcess === undefined
      ? DevProcess.live
      : Layer.succeed(DevProcess, options.devProcess),
    Layer.succeed(
      Entropy,
      Entropy.of({
        deploySlug: Effect.succeed("deploy"),
        tunnelSlug: Effect.succeed("generated"),
        relaySecret: Effect.succeed(Redacted.make("secret", { label: "relay-secret" })),
        accessPassword: Effect.succeed("tt_generated"),
      }),
    ),
    Layer.succeed(
      LocalConfigStore,
      LocalConfigStore.of({
        read: Effect.succeed({
          slug: "demo",
          relayDomain: "localhost",
          relaySecret: "secret",
          relayUrl: "http://127.0.0.1:3002",
        }),
        update: () => Effect.void,
      }),
    ),
    Layer.succeed(
      TunnelRuntime,
      options?.tunnelRuntime ?? TunnelRuntime.of({ run: () => Effect.never }),
    ),
    Layer.succeed(
      TunnelReporter,
      TunnelReporter.of({ emit: (event) => Effect.sync(() => events.push(event)) }),
    ),
  );

const gatewayStatusLayer = Layer.succeed(
  GatewayStatusChecker,
  GatewayStatusChecker.of({
    check: (url) => Effect.succeed({ url, status: "unreachable", reason: "transport-failure" }),
  }),
);
