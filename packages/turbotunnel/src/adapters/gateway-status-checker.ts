import { Context, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";

export const GATEWAY_STATUS_BODY_LIMIT = 8 * 1024;

export type GatewayStatusCheck =
  | {
      readonly url: string;
      readonly status: "running";
      readonly version: string;
    }
  | {
      readonly url: string;
      readonly status: "unreachable";
      readonly reason: "transport-failure" | "timeout";
    }
  | {
      readonly url: string;
      readonly status: "rejected";
      readonly statusCode: number;
    }
  | {
      readonly url: string;
      readonly status: "invalid-response";
      readonly reason: "malformed" | "too-large";
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
export type GatewayRunningStatus = typeof GatewayStatusSchema.Type;
const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeGatewayStatus = Schema.decodeUnknownEffect(GatewayStatusSchema);

class GatewayStatusBodyTooLarge extends Schema.TaggedErrorClass<GatewayStatusBodyTooLarge>()(
  "GatewayStatusBodyTooLarge",
  { limit: Schema.Number },
) {}

class GatewayStatusMalformed extends Schema.TaggedErrorClass<GatewayStatusMalformed>()(
  "GatewayStatusMalformed",
  { cause: Schema.Defect() },
) {}

export function decodeGatewayStatusResponse(
  response: HttpClientResponse,
): Effect.Effect<GatewayRunningStatus, GatewayStatusBodyTooLarge | GatewayStatusMalformed> {
  return readBoundedText(response, GATEWAY_STATUS_BODY_LIMIT).pipe(
    Effect.mapError((cause) =>
      cause instanceof GatewayStatusBodyTooLarge ? cause : new GatewayStatusMalformed({ cause }),
    ),
    Effect.flatMap((body) =>
      decodeJsonString(body).pipe(
        Effect.flatMap(decodeGatewayStatus),
        Effect.mapError((cause) => new GatewayStatusMalformed({ cause })),
      ),
    ),
  );
}

function readBoundedText(
  response: HttpClientResponse,
  limit: number,
): Effect.Effect<string, unknown> {
  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    return Effect.fail(new GatewayStatusBodyTooLarge({ limit }));
  }

  return Effect.gen(function* () {
    let length = 0;
    const chunks: Array<Uint8Array> = [];
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => {
        length += chunk.byteLength;
        if (length > limit) return Effect.fail(new GatewayStatusBodyTooLarge({ limit }));
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  });
}

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
          ? decodeGatewayStatusResponse(response).pipe(
              Effect.map(
                (status): GatewayStatusCheck => ({
                  url,
                  status: "running",
                  version: status.version,
                }),
              ),
              Effect.catchTags({
                GatewayStatusBodyTooLarge: () =>
                  Effect.succeed<GatewayStatusCheck>({
                    url,
                    status: "invalid-response",
                    reason: "too-large",
                  }),
                GatewayStatusMalformed: () =>
                  Effect.succeed<GatewayStatusCheck>({
                    url,
                    status: "invalid-response",
                    reason: "malformed",
                  }),
              }),
            )
          : Effect.succeed<GatewayStatusCheck>({
              url,
              status: "rejected",
              statusCode: response.status,
            }),
      ),
      Effect.timeoutOrElse({
        duration: 3_000,
        orElse: () =>
          Effect.succeed<GatewayStatusCheck>({ url, status: "unreachable", reason: "timeout" }),
      }),
      Effect.catch(() =>
        Effect.succeed<GatewayStatusCheck>({
          url,
          status: "unreachable",
          reason: "transport-failure",
        }),
      ),
    );
}
