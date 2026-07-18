import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { GatewayConfig } from "./src/gateway-config.js";
import { GatewayLive, GatewayServer } from "./src/gateway.js";
import { listenNodeServer } from "./src/node-server.js";

// GatewayLive owns the scoped runtime; this Bun entrypoint only binds its server and keeps it alive.
const program = Effect.gen(function* () {
  const config = yield* GatewayConfig;
  const server = yield* GatewayServer;

  yield* listenNodeServer(server, config.port);

  yield* Effect.logInfo("gateway listening").pipe(
    Effect.annotateLogs({ port: config.port, baseDomain: config.baseDomain }),
  );

  yield* Effect.never;
}).pipe(Effect.provide(GatewayLive(process.env)));

BunRuntime.runMain(program, { disableErrorReporting: true });
