import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { GatewayConfig } from "../src/gateway-config.js";

describe("GatewayConfig", () => {
  it.effect("rejects the implicit development secret for a public gateway domain", () =>
    Effect.gen(function* () {
      const error = yield* GatewayConfig.pipe(
        Effect.provide(
          GatewayConfig.layerFromEnv({
            TURBOTUNNEL_BASE_DOMAIN: "tunnel.example.com",
          }),
        ),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "GatewayConfigurationError",
        baseDomain: "tunnel.example.com",
      });
    }),
  );

  it.effect("allows the implicit development secret for loopback and .localhost domains", () =>
    Effect.gen(function* () {
      for (const baseDomain of ["localhost", "app.localhost", "127.0.0.1", "::1"]) {
        const config = yield* GatewayConfig.pipe(
          Effect.provide(GatewayConfig.layerFromEnv({ TURBOTUNNEL_BASE_DOMAIN: baseDomain })),
        );
        expect(config.baseDomain).toBe(baseDomain);
      }
    }),
  );
});
