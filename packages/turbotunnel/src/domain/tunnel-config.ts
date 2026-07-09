import { DEFAULT_LOCAL_CLIENT_POOL_SIZE } from "@turbotunnel/contracts";
import { Redacted } from "effect";

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

export type TunnelConfigResult =
  | { readonly _tag: "ok"; readonly config: HttpTunnelConfig }
  | { readonly _tag: "err"; readonly error: CliConfigError | NoGatewayConfigured };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function resolveTunnelConfig(options: {
  readonly input: HttpCommandInput;
  readonly env: TunnelEnvironment;
  readonly savedConfig: SavedTunnelConfig;
  readonly generatedSlug: string;
}): TunnelConfigResult {
  const portResult = parsePort(options.input.port);
  if (portResult._tag === "err") {
    return portResult;
  }
  const poolResult = parsePoolSize(options.input.pool);
  if (poolResult._tag === "err") {
    return poolResult;
  }

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
    return {
      _tag: "err",
      error: new NoGatewayConfigured({
        message:
          "No Turbotunnel gateway is configured yet. Run `tt deploy`, then expose your local app with `tt http 5173`. No local tunnel was started.",
      }),
    };
  }

  const slug =
    options.input.slug ??
    options.env.TURBOTUNNEL_SLUG ??
    options.savedConfig.slug ??
    options.generatedSlug;
  if (!SLUG_PATTERN.test(slug)) {
    return {
      _tag: "err",
      error: new CliConfigError({
        message:
          "Tunnel slug must contain only lowercase letters, digits, and hyphens, and must start with a letter or digit.",
      }),
    };
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

  const relayUrlResult = parseRelayUrl(
    options.input.relayUrl ?? options.env.TURBOTUNNEL_RELAY_URL ?? options.savedConfig.relayUrl,
  );
  if (relayUrlResult._tag === "err") {
    return relayUrlResult;
  }

  return {
    _tag: "ok",
    config: {
      slug,
      relayDomain,
      relaySecret: Redacted.make(relaySecret, { label: "relay-secret" }),
      relayUrl: relayUrlResult.value,
      poolSize: poolResult.value,
      target: {
        protocol: "http",
        host: options.input.host,
        port: portResult.value,
      },
    },
  };
}

function parseRelayUrl(
  value: string | undefined,
):
  | { readonly _tag: "ok"; readonly value: string | undefined }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (value === undefined) {
    return { _tag: "ok", value: undefined };
  }

  if (!URL.canParse(value)) {
    return { _tag: "err", error: new CliConfigError({ message: "Relay URL must be a valid http, https, ws, or wss URL." }) };
  }

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { _tag: "err", error: new CliConfigError({ message: "Relay URL must use http, https, ws, or wss." }) };
  }

  return { _tag: "ok", value: url.toString() };
}

function parsePort(
  port: number,
):
  | { readonly _tag: "ok"; readonly value: number }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { _tag: "err", error: new CliConfigError({ message: "Port must be an integer from 1 to 65535." }) };
  }

  return { _tag: "ok", value: port };
}

function parsePoolSize(
  pool: number | undefined,
):
  | { readonly _tag: "ok"; readonly value: number }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (pool === undefined) {
    return { _tag: "ok", value: DEFAULT_LOCAL_CLIENT_POOL_SIZE };
  }

  if (!Number.isInteger(pool) || pool < 1 || pool > 16) {
    return { _tag: "err", error: new CliConfigError({ message: "Pool size must be an integer from 1 to 16." }) };
  }

  return { _tag: "ok", value: pool };
}
