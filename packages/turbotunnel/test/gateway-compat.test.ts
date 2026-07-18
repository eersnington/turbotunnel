import { describe, expect, it } from "@effect/vitest";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Redacted } from "effect";

import {
  GatewayStatusChecker,
  type GatewayStatusCheck,
} from "../src/adapters/gateway-status-checker.js";
import { assertCompatibleGateway } from "../src/domain/gateway-compat.js";
import type { HttpTunnelConfig } from "../src/domain/tunnel-config.js";

describe("assertCompatibleGateway", () => {
  it.effect("allows a transport-unreachable gateway so an existing tunnel may reconnect", () =>
    assertCompatibleGateway(
      checker({ status: "unreachable", reason: "transport-failure" }),
      config,
      undefined,
    ),
  );

  for (const result of [
    { status: "rejected", statusCode: 401 } as const,
    { status: "invalid-response", reason: "malformed" } as const,
    { status: "running", version: "0.0.0-incompatible" } as const,
  ]) {
    it.effect(`rejects ${result.status}`, () =>
      Effect.gen(function* () {
        const error = yield* assertCompatibleGateway(checker(result), config, undefined).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("CliConfigError");
      }),
    );
  }

  it.effect("accepts the installed gateway version", () =>
    assertCompatibleGateway(
      checker({ status: "running", version: TURBOTUNNEL_VERSION }),
      config,
      undefined,
    ),
  );
});

type WithoutUrl<T> = T extends unknown ? Omit<T, "url"> : never;

function checker(result: WithoutUrl<GatewayStatusCheck>) {
  return GatewayStatusChecker.of({ check: (url) => Effect.succeed({ url, ...result }) });
}

const config: HttpTunnelConfig = {
  slug: "demo",
  relayDomain: "{slug}.example.com",
  relaySecret: Redacted.make("secret", { label: "relay-secret" }),
  relayUrl: undefined,
  poolSize: 1,
  target: { protocol: "http", host: "localhost", port: 5173 },
  publicHost: "demo.example.com",
  accessPolicy: { type: "public" },
};
