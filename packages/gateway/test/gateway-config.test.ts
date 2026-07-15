import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { GatewayConfig } from "../src/gateway-config.js";

describe("GatewayConfig", () => {
  it.effect("rejects an explicitly empty relay secret", () =>
    Effect.gen(function* () {
      const error = yield* GatewayConfig.pipe(
        Effect.provide(
          GatewayConfig.layerFromEnv({
            TURBOTUNNEL_RELAY_SECRET: "",
          }),
        ),
        Effect.flip,
      );

      expect(error).toBeDefined();
    }),
  );
});
