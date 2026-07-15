import { DEFAULT_LOCAL_CLIENT_POOL_SIZE } from "@turbotunnel/contracts";
import { Effect, Redacted } from "effect";

import { CliConfigError, NoGatewayConfigured } from "../errors.js";

export type HttpCommandInput = {
  readonly slug?: string;
  readonly host: string;
  readonly pool?: number;
  readonly domain?: string;
  readonly secret?: string;
  readonly relayUrl?: string;
  readonly port: number;
};

export type TunnelEnvironment = {
  readonly TURBOTUNNEL_SLUG?: string;
  readonly TURBOTUNNEL_BASE_DOMAIN?: string;
  readonly TURBOTUNNEL_RELAY_DOMAIN?: string;
  readonly TURBOTUNNEL_RELAY_SECRET?: string;
  readonly TURBOTUNNEL_RELAY_URL?: string;
};

export type SavedTunnelConfig = {
  readonly slug?: string;
  readonly relayDomain?: string;
  readonly relaySecret?: string;
  readonly relayUrl?: string;
};

export type LocalTarget = {
  readonly protocol: "http";
  readonly host: string;
  readonly port: number;
};

export type HttpTunnelConfig = {
  readonly slug: string;
  readonly relayDomain: string;
  readonly relaySecret: Redacted.Redacted<string>;
  readonly relayUrl: string | undefined;
  readonly poolSize: number;
  readonly target: LocalTarget;
};

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const resolveTunnelConfig = Effect.fn("resolveTunnelConfig")(function* (options: {
  readonly input: HttpCommandInput;
  readonly env: TunnelEnvironment;
  readonly savedConfig: SavedTunnelConfig;
  readonly generatedSlug: string;
}): Effect.fn.Return<HttpTunnelConfig, CliConfigError | NoGatewayConfigured> {
  const port = yield* parsePort(options.input.port);
  const poolSize = yield* parsePoolSize(options.input.pool);

  const hasExplicitGatewayInput =
    options.input.domain !== undefined ||
    options.input.secret !== undefined ||
    options.input.relayUrl !== undefined ||
    options.env.TURBOTUNNEL_BASE_DOMAIN !== undefined ||
    options.env.TURBOTUNNEL_RELAY_DOMAIN !== undefined ||
    options.env.TURBOTUNNEL_RELAY_SECRET !== undefined ||
    options.env.TURBOTUNNEL_RELAY_URL !== undefined;
  const hasSavedGateway =
    (options.savedConfig.relayDomain !== undefined &&
      options.savedConfig.relaySecret !== undefined) ||
    options.savedConfig.relayUrl !== undefined;

  if (!hasExplicitGatewayInput && !hasSavedGateway) {
    return yield* new NoGatewayConfigured({
      message:
        "No Turbotunnel gateway is configured yet. Run `tt deploy`, then expose your local app with `tt http 5173`. No local tunnel was started.",
    });
  }

  const slug =
    options.input.slug ??
    options.env.TURBOTUNNEL_SLUG ??
    options.savedConfig.slug ??
    options.generatedSlug;
  if (!SLUG_PATTERN.test(slug)) {
    return yield* new CliConfigError({
      message:
        "Tunnel slug must contain only lowercase letters, digits, and hyphens, and must start with a letter or digit.",
    });
  }

  const relayDomain =
    options.input.domain ??
    options.env.TURBOTUNNEL_BASE_DOMAIN ??
    options.env.TURBOTUNNEL_RELAY_DOMAIN ??
    options.savedConfig.relayDomain ??
    "localhost";
  const relaySecret =
    options.input.secret ??
    options.env.TURBOTUNNEL_RELAY_SECRET ??
    options.savedConfig.relaySecret ??
    "dev_secret";

  const relayUrl = yield* parseRelayUrl(
    options.input.relayUrl ?? options.env.TURBOTUNNEL_RELAY_URL ?? options.savedConfig.relayUrl,
  );

  return {
    slug,
    relayDomain,
    relaySecret: Redacted.make(relaySecret, { label: "relay-secret" }),
    relayUrl,
    poolSize,
    target: {
      protocol: "http",
      host: options.input.host,
      port,
    },
  };
});

function parseRelayUrl(
  value: string | undefined,
): Effect.Effect<string | undefined, CliConfigError> {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  if (!URL.canParse(value)) {
    return Effect.fail(
      new CliConfigError({
        message: "Relay URL must be a valid http, https, ws, or wss URL.",
      }),
    );
  }

  const url = new URL(value);
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "ws:" &&
    url.protocol !== "wss:"
  ) {
    return Effect.fail(
      new CliConfigError({ message: "Relay URL must use http, https, ws, or wss." }),
    );
  }

  return Effect.succeed(url.toString());
}

function parsePort(port: number): Effect.Effect<number, CliConfigError> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Effect.fail(new CliConfigError({ message: "Port must be an integer from 1 to 65535." }));
  }

  return Effect.succeed(port);
}

function parsePoolSize(pool: number | undefined): Effect.Effect<number, CliConfigError> {
  if (pool === undefined) {
    return Effect.succeed(DEFAULT_LOCAL_CLIENT_POOL_SIZE);
  }

  if (!Number.isInteger(pool) || pool < 1 || pool > 16) {
    return Effect.fail(
      new CliConfigError({ message: "Pool size must be an integer from 1 to 16." }),
    );
  }

  return Effect.succeed(pool);
}
