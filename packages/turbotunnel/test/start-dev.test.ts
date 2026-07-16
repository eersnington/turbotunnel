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
        const script =
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ PORT: process.env.PORT, URL: process.env.TURBOTUNNEL_URL, HOST: process.env.TURBOTUNNEL_HOST, SLUG: process.env.TURBOTUNNEL_SLUG })); process.exit(19)";

        const exitCode = yield* startDev({
          input: { port: 5173, command: [process.execPath, "-e", script, outputPath] },
          cwd: root,
          env: {},
        }).pipe(Effect.provide(testLayer), Effect.provide(NodeServices.layer));

        expect(exitCode).toBe(19);
        expect(JSON.parse(yield* Effect.promise(() => readFile(outputPath, "utf8")))).toEqual({
          PORT: "5173",
          URL: "https://demo.tunnel.example.com/",
          HOST: "demo.tunnel.example.com",
          SLUG: "demo",
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

const testLayer = Layer.mergeAll(
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
      snapshot: Effect.succeed(undefined),
      run: () => Effect.never,
    }),
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
        snapshot: Effect.succeed(undefined),
        run: () => Effect.never,
      }),
    ),
  );
