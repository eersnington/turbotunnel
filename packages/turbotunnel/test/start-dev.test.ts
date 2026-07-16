import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { DevProcess } from "../src/adapters/dev-process.js";
import { Entropy } from "../src/adapters/entropy.js";
import { LocalAppProbe } from "../src/adapters/local-app-probe.js";
import { LocalConfigStore } from "../src/adapters/local-config-store.js";
import { PortAllocator } from "../src/adapters/port-allocator.js";
import { ProjectDiscovery } from "../src/adapters/project-discovery.js";
import { TunnelRuntime } from "../src/adapters/tunnel-runtime.js";
import { startDev } from "../src/programs/start-dev.js";
import { TunnelReporter } from "../src/runtime/tunnel-reporter.js";
import type { LifecycleEvent } from "../src/runtime/lifecycle-event.js";

describe("startDev", () => {
  it.effect("injects the resolved tunnel environment and returns the child exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-dev-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(root, "package.json"),
            JSON.stringify({ scripts: { dev: "node server.js" } }),
          ),
        );
        const outputPath = join(root, "environment.json");
        const events: Array<LifecycleEvent> = [];
        const script =
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ PORT: process.env.PORT, URL: process.env.TURBOTUNNEL_URL, HOST: process.env.TURBOTUNNEL_HOST, SLUG: process.env.TURBOTUNNEL_SLUG })); process.exit(19)";

        const exitCode = yield* startDev({
          input: {
            port: 5173,
            command: [process.execPath, "-e", script, outputPath, "--api-key", "secret"],
          },
          cwd: root,
          env: {},
        }).pipe(Effect.provide(makeTestLayer(events)), Effect.provide(NodeServices.layer));

        expect(exitCode).toBe(19);
        expect(JSON.parse(yield* Effect.promise(() => readFile(outputPath, "utf8")))).toEqual({
          PORT: "5173",
          URL: "http://demo.localhost:3002/",
          HOST: "demo.localhost:3002",
          SLUG: "demo",
        });
        expect(events[0]).toEqual({
          _tag: "DevelopmentProcessStarting",
          command: `${process.execPath} (custom command)`,
        });
      }),
    ),
  );

  it.effect("fails with a typed error when readiness exceeds 60 seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "turbotunnel-dev-timeout-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(root, "package.json"),
            JSON.stringify({ scripts: { dev: "node server.js" } }),
          ),
        );
        const started = yield* Deferred.make<void>();
        const running = startDev({
          input: { port: 5173, command: [process.execPath, "server.js"] },
          cwd: root,
          env: {},
        }).pipe(Effect.provide(makeTimeoutLayer(started)), Effect.provide(NodeServices.layer));

        const fiber = yield* Effect.forkChild(running);
        yield* Deferred.await(started);
        yield* TestClock.adjust("60 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error._tag).toBe("DevServerReadinessTimeout");
        if (error._tag === "DevServerReadinessTimeout") {
          expect(error.port).toBe(5173);
          expect(error.timeoutSeconds).toBe(60);
        }
      }),
    ),
  );
});

const makeTestLayer = (events: Array<LifecycleEvent>) =>
  Layer.mergeAll(
    ProjectDiscovery.live,
    DevProcess.live,
    Layer.succeed(PortAllocator, PortAllocator.of({ freePort: Effect.succeed(6000) })),
    Layer.succeed(
      Entropy,
      Entropy.of({
        deploySlug: Effect.succeed("deploy"),
        tunnelSlug: Effect.succeed("generated"),
        relaySecret: Effect.succeed(Redacted.make("secret", { label: "relay-secret" })),
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
        write: () => Effect.void,
      }),
    ),
    Layer.succeed(
      LocalAppProbe,
      LocalAppProbe.of({
        assertReachable: () => Effect.void,
        waitUntilReachable: () => Effect.never,
      }),
    ),
    Layer.succeed(
      TunnelRuntime,
      TunnelRuntime.of({
        run: (_config, beforeConnect = Effect.void) =>
          beforeConnect.pipe(Effect.andThen(Effect.never)),
      }),
    ),
    Layer.succeed(
      TunnelReporter,
      TunnelReporter.of({ emit: (event) => Effect.sync(() => events.push(event)) }),
    ),
  );

const makeTimeoutLayer = (started: Deferred.Deferred<void>) =>
  Layer.mergeAll(
    ProjectDiscovery.live,
    Layer.succeed(
      DevProcess,
      DevProcess.of({
        spawn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.as({ exitCode: Effect.never })),
      }),
    ),
    Layer.succeed(PortAllocator, PortAllocator.of({ freePort: Effect.succeed(6000) })),
    Layer.succeed(
      Entropy,
      Entropy.of({
        deploySlug: Effect.succeed("deploy"),
        tunnelSlug: Effect.succeed("generated"),
        relaySecret: Effect.succeed(Redacted.make("secret", { label: "relay-secret" })),
      }),
    ),
    Layer.succeed(
      LocalConfigStore,
      LocalConfigStore.of({
        read: Effect.succeed({
          slug: "demo",
          relayDomain: "tunnel.example.com",
          relaySecret: "secret",
        }),
        write: () => Effect.void,
      }),
    ),
    Layer.succeed(
      LocalAppProbe,
      LocalAppProbe.of({
        assertReachable: () => Effect.void,
        waitUntilReachable: () => Effect.never,
      }),
    ),
    Layer.succeed(
      TunnelRuntime,
      TunnelRuntime.of({
        run: (_config, beforeConnect = Effect.void) =>
          beforeConnect.pipe(Effect.andThen(Effect.never)),
      }),
    ),
    Layer.succeed(TunnelReporter, TunnelReporter.of({ emit: () => Effect.void })),
  );
