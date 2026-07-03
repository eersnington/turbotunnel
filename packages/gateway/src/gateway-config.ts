import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";

export type GatewayConfigShape = {
  readonly baseDomain: string;
  readonly relaySecret: string;
  readonly queueRegion: string;
  readonly brokerKind: "memory" | "vercel";
  readonly port: number;
};

const portSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const brokerKindSchema = Schema.Literals(["memory", "vercel"]);

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
    const relaySecret = yield* Config.schema(
      Schema.NonEmptyString,
      "TURBOTUNNEL_RELAY_SECRET",
    ).pipe(Config.withDefault("dev_secret"));
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

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }

  return Object.fromEntries(entries);
}
