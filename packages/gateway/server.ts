import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { GatewayConfig } from "./src/gateway-config.js";
import { GatewayLive, makeGatewayServer } from "./src/gateway.js";

const program = Effect.gen(function* () {
  const config = yield* GatewayConfig;
  const server = yield* makeGatewayServer();

  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.listen(config.port, resolve);
      }),
  );

  yield* Effect.logInfo("gateway listening").pipe(
    Effect.annotateLogs({ port: config.port, baseDomain: config.baseDomain }),
  );

  yield* Effect.never;
}).pipe(Effect.provide(GatewayLive(process.env)));

BunRuntime.runMain(program, { disableErrorReporting: true });
