import { tunnelListResponseSchema, type TunnelListResponse } from "@turbotunnel/contracts";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { Size } from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http/HttpClient";
import { MaxBodySize } from "effect/unstable/http/HttpIncomingMessage";

import { gatewayUrl } from "../domain/tunnel-url.js";
import { GatewayControlError, NoGatewayConfigured, type ListTunnelsError } from "../errors.js";
import { LocalConfigStore, type LocalConfig } from "./local-config-store.js";

export type GatewayControlClientShape = {
  readonly listTunnels: Effect.Effect<TunnelListResponse, ListTunnelsError>;
};

export class GatewayControlClient extends Context.Service<
  GatewayControlClient,
  GatewayControlClientShape
>()("turbotunnel/effect/GatewayControlClient") {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient;
      const configStore = yield* LocalConfigStore;
      return GatewayControlClient.of({
        listTunnels: configStore.read.pipe(
          Effect.flatMap(resolveGatewayConnection),
          Effect.flatMap((connection) => requestTunnelList(httpClient, connection)),
        ),
      });
    }),
  );
}

type GatewayConnection = {
  readonly url: string;
  readonly relaySecret: Redacted.Redacted<string>;
};

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const MAX_TUNNEL_LIST_BODY_BYTES = Size(1_048_576);
const decodeTunnelList = Schema.decodeUnknownEffect(tunnelListResponseSchema, {
  onExcessProperty: "error",
});

const resolveGatewayConnection = Effect.fn("GatewayControlClient.resolveConfig")(function* (
  config: LocalConfig,
): Effect.fn.Return<GatewayConnection, NoGatewayConfigured | GatewayControlError> {
  const usesExplicitRelay = config.relayUrl !== undefined;
  if (
    !usesExplicitRelay &&
    (config.slug === undefined ||
      config.relayDomain === undefined ||
      config.relaySecret === undefined)
  ) {
    return yield* new NoGatewayConfigured({
      message:
        "No Turbotunnel gateway is configured yet. Run `tt deploy`, then retry `tt list`. No gateway was contacted.",
    });
  }

  const connectionUrl = yield* Effect.try({
    try: () => {
      const baseUrl = gatewayUrl({
        slug: config.slug ?? "gateway",
        relayDomain: config.relayDomain ?? "localhost",
        relayUrl: config.relayUrl,
      });
      return { baseUrl, parsed: new URL(baseUrl) };
    },
    catch: () =>
      new GatewayControlError({
        reason: "invalid-url",
        url: sanitizedUrl(config.relayUrl ?? config.relayDomain ?? ""),
        message:
          "The configured gateway URL is invalid. Fix the saved Turbotunnel config or run `tt deploy`, then retry `tt list`. No gateway was contacted.",
      }),
  });
  if (connectionUrl.parsed.username.length > 0 || connectionUrl.parsed.password.length > 0) {
    return yield* new GatewayControlError({
      reason: "invalid-url",
      url: sanitizedUrl(connectionUrl.baseUrl),
      message:
        "The configured gateway URL must not contain a username or password. Remove URL credentials and retry `tt list`. No gateway was contacted.",
    });
  }

  return {
    url: new URL("/_turbotunnel/tunnels", connectionUrl.parsed).toString(),
    relaySecret: Redacted.make(config.relaySecret ?? "dev_secret", { label: "relay-secret" }),
  };
});

const requestTunnelList = Effect.fn("GatewayControlClient.listTunnels")(function* (
  httpClient: HttpClient,
  connection: GatewayConnection,
): Effect.fn.Return<TunnelListResponse, GatewayControlError> {
  const response = yield* httpClient
    .get(connection.url, {
      accept: "application/json",
      headers: { authorization: `Bearer ${Redacted.value(connection.relaySecret)}` },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new GatewayControlError({
            reason: "request-failed",
            url: connection.url,
            cause,
            message: `Turbotunnel could not reach the configured gateway at ${connection.url}. Check your network and gateway deployment, then retry \`tt list\`.`,
          }),
      ),
      Effect.timeoutOrElse({
        duration: 5_000,
        orElse: () =>
          Effect.fail(
            new GatewayControlError({
              reason: "timeout",
              url: connection.url,
              message: `The configured gateway at ${connection.url} did not respond within 5 seconds. Check its deployment logs, then retry \`tt list\`.`,
            }),
          ),
      }),
    );

  if (response.status === 401 || response.status === 403) {
    return yield* new GatewayControlError({
      reason: "unauthorized",
      url: connection.url,
      status: response.status,
      message: `The configured gateway rejected the saved relay secret with HTTP ${response.status}. Run \`tt deploy\` to refresh the gateway configuration, then retry \`tt list\`.`,
    });
  }
  if (response.status !== 200) {
    return yield* new GatewayControlError({
      reason: "bad-status",
      url: connection.url,
      status: response.status,
      message: `The configured gateway returned HTTP ${response.status} from its tunnel-list endpoint. Check its deployment logs, then retry \`tt list\`.`,
    });
  }

  const body = yield* response.text.pipe(
    Effect.provideService(MaxBodySize, MAX_TUNNEL_LIST_BODY_BYTES),
    Effect.mapError(
      (cause) =>
        new GatewayControlError({
          reason: "invalid-response",
          url: connection.url,
          cause,
          message:
            "The configured gateway returned a tunnel list larger than 1 MiB or its response could not be read. Reduce active tunnel churn, then retry `tt list`.",
        }),
    ),
  );
  const json = yield* decodeJsonString(body).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayControlError({
          reason: "invalid-response",
          url: connection.url,
          cause,
          message:
            "The configured gateway returned a non-JSON tunnel list. Update or redeploy the gateway, then retry `tt list`.",
        }),
    ),
  );
  return yield* decodeTunnelList(json).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayControlError({
          reason: "invalid-response",
          url: connection.url,
          cause,
          message:
            "The configured gateway returned an unsupported tunnel-list version or shape. Update the CLI and gateway together, then retry `tt list`.",
        }),
    ),
  );
});

function sanitizedUrl(value: string): string {
  // Error reporting must remain total even when the configured URL is malformed.
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "invalid gateway URL";
  }
}
