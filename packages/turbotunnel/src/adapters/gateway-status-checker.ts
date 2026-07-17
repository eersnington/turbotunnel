import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";

export type GatewayStatusCheck =
  | {
      readonly url: string;
      readonly status: "running";
      readonly version: string;
    }
  | {
      readonly url: string;
      readonly status: "unreachable";
      readonly statusCode?: number;
    };

export type GatewayStatusCheckerShape = {
  readonly check: (url: string, relaySecret?: string) => Effect.Effect<GatewayStatusCheck>;
};

export class GatewayStatusChecker extends Context.Service<
  GatewayStatusChecker,
  GatewayStatusCheckerShape
>()("turbotunnel/effect/GatewayStatusChecker") {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient;
      return GatewayStatusChecker.of({
        check: (url, relaySecret) => checkGateway(client, url, relaySecret),
      });
    }),
  );
}

const GatewayStatusSchema = Schema.Struct({
  status: Schema.Literal("running"),
  version: Schema.String,
  baseDomain: Schema.String,
  broker: Schema.String,
  queueRegion: Schema.String,
});
const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeGatewayStatus = Schema.decodeUnknownEffect(GatewayStatusSchema);

function checkGateway(
  client: HttpClient,
  url: string,
  relaySecret?: string,
): Effect.Effect<GatewayStatusCheck> {
  return client
    .get(url, {
      accept: "application/json",
      headers: relaySecret === undefined ? undefined : { authorization: `Bearer ${relaySecret}` },
    })
    .pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.text.pipe(
              Effect.flatMap(decodeJsonString),
              Effect.flatMap(decodeGatewayStatus),
              Effect.map(
                (status): GatewayStatusCheck => ({
                  url,
                  status: "running",
                  version: status.version,
                }),
              ),
            )
          : Effect.succeed<GatewayStatusCheck>({
              url,
              status: "unreachable",
              statusCode: response.status,
            }),
      ),
      Effect.timeoutOrElse({
        duration: 3_000,
        orElse: () => Effect.succeed<GatewayStatusCheck>({ url, status: "unreachable" }),
      }),
      Effect.catch(() => Effect.succeed<GatewayStatusCheck>({ url, status: "unreachable" })),
    );
}
