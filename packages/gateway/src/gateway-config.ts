import { isIP } from "node:net";

import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

export type GatewayConfigShape = {
  readonly baseDomain: string;
  readonly relaySecret: Redacted.Redacted<string>;
  readonly queueRegion: string;
  readonly brokerKind: "memory" | "vercel";
  readonly port: number;
};

const portSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const brokerKindSchema = Schema.Literals(["memory", "vercel"]);

export class GatewayConfigurationError extends Schema.TaggedErrorClass<GatewayConfigurationError>()(
  "GatewayConfigurationError",
  {
    baseDomain: Schema.String,
    message: Schema.String,
  },
) {}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayConfigShape>()(
  "turbotunnel/gateway/GatewayConfig",
) {
  static readonly layer = Layer.effect(this)(loadGatewayConfig());

  static readonly layerFromEnv = (env: NodeJS.ProcessEnv) =>
    this.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: envRecord(env) }))),
    );
}

function loadGatewayConfig() {
  return Effect.gen(function* () {
    const baseDomain = yield* Config.schema(Schema.NonEmptyString, "TURBOTUNNEL_BASE_DOMAIN").pipe(
      Config.withDefault("localhost"),
    );
    const relaySecretOption = yield* Config.option(
      Config.schema(Schema.Redacted(Schema.NonEmptyString), "TURBOTUNNEL_RELAY_SECRET"),
    );
    const configuredRelaySecret = Option.getOrUndefined(relaySecretOption);
    if (configuredRelaySecret === undefined && !isLocalGatewayDomain(baseDomain)) {
      return yield* new GatewayConfigurationError({
        baseDomain,
        message: `TURBOTUNNEL_RELAY_SECRET is required when TURBOTUNNEL_BASE_DOMAIN is "${baseDomain}". Set a non-empty secret and restart the gateway; the development secret is only allowed for loopback and .localhost gateways.`,
      });
    }
    const relaySecret =
      configuredRelaySecret ?? Redacted.make("dev_secret", { label: "relay-secret" });
    const queueRegion = yield* Config.schema(
      Schema.NonEmptyString,
      "TURBOTUNNEL_QUEUE_REGION",
    ).pipe(Config.withDefault("iad1"));
    const brokerOption = yield* Config.option(
      Config.schema(brokerKindSchema, "TURBOTUNNEL_BROKER"),
    );
    const nodeEnv = yield* Config.option(Config.schema(Schema.String, "NODE_ENV"));
    const port = yield* Config.schema(portSchema, "PORT").pipe(Config.withDefault(3002));

    return GatewayConfig.of({
      baseDomain,
      relaySecret,
      queueRegion,
      brokerKind:
        Option.getOrUndefined(brokerOption) ??
        (Option.getOrUndefined(nodeEnv) === "development" ? "memory" : "vercel"),
      port,
    });
  });
}

function isLocalGatewayDomain(domain: string): boolean {
  const hostname = domain
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  const ipVersion = isIP(hostname);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (ipVersion === 4 && hostname.startsWith("127.")) ||
    (ipVersion === 6 && hostname === "::1")
  );
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }

  return Object.fromEntries(entries);
}
