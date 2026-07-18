/** Composes gateway services while scoped layers own the Node server and in-process state. */
import type { Server } from "node:http";

import { Context, Effect, Layer } from "effect";

import { GatewayConfig } from "./gateway-config.js";
import { GatewayState } from "./gateway-state.js";
import { MemoryQueue } from "./memory-queue.js";
import { makeNodeGatewayServer } from "./node-server.js";
import { OidcToken, OidcTokenAuthority } from "./oidc-token.js";
import { PublicRouteRegistry } from "./public-route-registry.js";
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
const gatewayLive = (
  env: NodeJS.ProcessEnv,
  authorityLayer: Layer.Layer<OidcTokenAuthority, never, OidcToken>,
) => {
  const oidcTokenLayer = OidcToken.layer(env.VERCEL_OIDC_TOKEN);
  const configurationLayer = GatewayConfig.layerFromEnv(env);
  const stateLayer = GatewayState.layer;
  const baseLayer = Layer.mergeAll(configurationLayer, stateLayer, oidcTokenLayer);
  const queueLayer = Layer.unwrap(
    GatewayConfig.use((config) =>
      Effect.succeed(config.brokerKind === "memory" ? MemoryQueue.sharedLayer : VercelQueue.layer),
    ),
  ).pipe(Layer.provide(baseLayer));
  const authorityLayerWithToken = authorityLayer.pipe(Layer.provide(oidcTokenLayer));
  const requestServicesLayer = Layer.mergeAll(baseLayer, queueLayer, authorityLayerWithToken);
  const registryLayer = PublicRouteRegistry.layer.pipe(Layer.provide(requestServicesLayer));
  const serverDependenciesLayer = Layer.merge(requestServicesLayer, registryLayer);
  const serverLayer = GatewayServer.layer.pipe(Layer.provide(serverDependenciesLayer));
  return Layer.merge(serverDependenciesLayer, serverLayer);
};

/** Gateway runtime that never grants incoming public requests credential authority. */
export const GatewayLive = (env: NodeJS.ProcessEnv) => gatewayLive(env, OidcTokenAuthority.none);

/** Vercel deployment runtime whose platform adapter may refresh invocation OIDC credentials. */
export const VercelGatewayLive = (env: NodeJS.ProcessEnv) =>
  gatewayLive(env, OidcTokenAuthority.vercel);
