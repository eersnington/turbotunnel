import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { GatewayConfig } from "../src/gateway-config.js";

describe("GatewayConfig", () => {
  test("rejects an explicitly empty relay secret", async () => {
    const exit = await Effect.runPromiseExit(
      GatewayConfig.pipe(
        Effect.provide(
          GatewayConfig.layerFromEnv({
            TURBOTUNNEL_RELAY_SECRET: "",
          }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });
});
