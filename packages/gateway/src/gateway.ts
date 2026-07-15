/** Composes gateway services while scoped layers own the Node server and in-process state. */
import type { Server } from "node:http";

import { Context, Effect, Layer } from "effect";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState } from "./gateway-state.js";
import { MemoryQueue } from "./memory-queue.js";
import { makeNodeGatewayServer } from "./node-server.js";
import { OidcToken } from "./oidc-token.js";
import { VercelQueue } from "./vercel-queue.js";

/** Effect service for the scoped Node server owned by the gateway runtime. */
export class GatewayServer extends Context.Service<GatewayServer, Server>()(
  "turbotunnel/gateway/GatewayServer",
) {
  /** Layer that acquires and releases the raw Node gateway server. */
  static readonly layer = Layer.effect(
    this,
    makeNodeGatewayServer().pipe(Effect.map(GatewayServer.of)),
  );
}

/** Builds the complete gateway runtime layer while parsing the supplied process environment. */
export const GatewayLive = (env: NodeJS.ProcessEnv) => {
  const baseLayer = Layer.mergeAll(
    GatewayConfig.layerFromEnv(env),
    GatewayState.layer,
    OidcToken.layer,
  );
  const queueLayer = Layer.unwrap(
    GatewayConfig.use((config) =>
      Effect.succeed(config.brokerKind === "memory" ? MemoryQueue.sharedLayer : VercelQueue.layer),
    ),
  ).pipe(Layer.provide(baseLayer));
  const dependencies = Layer.mergeAll(baseLayer, queueLayer);
  return GatewayServer.layer.pipe(Layer.provideMerge(dependencies));
};
