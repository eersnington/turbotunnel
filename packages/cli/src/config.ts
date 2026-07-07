import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LOCAL_CLIENT_POOL_SIZE } from "@turbotunnel/protocol";
import { Effect, Redacted, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { customAlphabet } from "nanoid";

import {
  CliConfigError,
  ConfigFileParseError,
  ConfigFileReadError,
  NoGatewayConfigured,
} from "./errors.js";

export type HttpCommandInput = {
  readonly slug?: string;
  readonly host: string;
  readonly pool?: number;
  readonly domain?: string;
  readonly secret?: string;
  readonly relayUrl?: string;
  readonly port: number;
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

type LocalConfig = typeof LocalConfigSchema.Type;

const cleanSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 5);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const LocalConfigSchema = Schema.Struct({
  project: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  relayDomain: Schema.optional(Schema.String),
  relaySecret: Schema.optional(Schema.String),
  relayUrl: Schema.optional(Schema.String),
  queueRegion: Schema.optional(Schema.String),
});

/** Resolve CLI/env/file inputs into the local tunnel runtime config. */
export const resolveHttpTunnelConfig = Effect.fn("resolveHttpTunnelConfig")(function* (
  input: HttpCommandInput,
): Effect.fn.Return<
  HttpTunnelConfig,
  CliConfigError | ConfigFileParseError | ConfigFileReadError | NoGatewayConfigured,
  FileSystem
> {
  const fileConfig = yield* readLocalConfig();
  const port = yield* parsePort(input.port);
  const poolSize = yield* parsePoolSize(input.pool);
  const env = process.env;
  const hasExplicitGatewayInput =
    input.domain !== undefined ||
    input.secret !== undefined ||
    input.relayUrl !== undefined ||
    env.TURBOTUNNEL_BASE_DOMAIN !== undefined ||
    env.TURBOTUNNEL_RELAY_DOMAIN !== undefined ||
    env.TURBOTUNNEL_RELAY_SECRET !== undefined ||
    env.TURBOTUNNEL_RELAY_URL !== undefined;
  const hasSavedGateway =
    (fileConfig.relayDomain !== undefined && fileConfig.relaySecret !== undefined) ||
    fileConfig.relayUrl !== undefined;

  if (!hasExplicitGatewayInput && !hasSavedGateway) {
    return yield* new NoGatewayConfigured({
      message:
        "No Turbotunnel gateway is configured yet.\n\nRun:\n  tt deploy\n\nThen expose your local app:\n  tt http 5173\n\nNo local tunnel was started.",
    });
  }

  const relayDomain =
    input.domain ??
    env.TURBOTUNNEL_BASE_DOMAIN ??
    env.TURBOTUNNEL_RELAY_DOMAIN ??
    fileConfig.relayDomain ??
    "localhost";
  const relaySecret =
    input.secret ?? env.TURBOTUNNEL_RELAY_SECRET ?? fileConfig.relaySecret ?? "dev_secret";
  const relayUrl = input.relayUrl ?? env.TURBOTUNNEL_RELAY_URL ?? fileConfig.relayUrl;
  const slug = input.slug ?? env.TURBOTUNNEL_SLUG ?? fileConfig.slug ?? cleanSlug();

  if (!SLUG_PATTERN.test(slug)) {
    return yield* new CliConfigError({
      message:
        "Tunnel slug must contain only lowercase letters, digits, and hyphens, and must start with a letter or digit.",
    });
  }

  return {
    slug,
    relayDomain,
    relaySecret: Redacted.make(relaySecret, { label: "relay-secret" }),
    relayUrl,
    poolSize,
    target: {
      protocol: "http",
      host: input.host,
      port,
    },
  };
});

export const readLocalConfig = Effect.fn("readLocalConfig")(function* (): Effect.fn.Return<
  LocalConfig,
  ConfigFileParseError | ConfigFileReadError,
  FileSystem
> {
  const fs = yield* FileSystem;
  const path = join(homedir(), ".turbotunnel", "config.json");
  const exists = yield* fs.exists(path).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileReadError({
          path,
          cause,
          message:
            "Couldn't check ~/.turbotunnel/config.json. Confirm the file permissions and retry. No local tunnel was started.",
        }),
    ),
  );

  if (!exists) {
    return {};
  }

  const text = yield* fs.readFileString(path, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileReadError({
          path,
          cause,
          message:
            "Couldn't read ~/.turbotunnel/config.json. Fix the file permissions or remove the file, then retry. No local tunnel was started.",
        }),
    ),
  );
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      new ConfigFileParseError({
        path,
        cause,
        message:
          "~/.turbotunnel/config.json is not valid JSON. Fix or remove the file, then retry. No local tunnel was started.",
      }),
  });

  return yield* Schema.decodeUnknownEffect(LocalConfigSchema)(json).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileParseError({
          path,
          cause,
          message:
            "~/.turbotunnel/config.json has an unsupported shape. Keep only string fields such as slug, relayDomain, relaySecret, and relayUrl, then retry. No local tunnel was started.",
        }),
    ),
  );
});

function parsePort(port: number): Effect.Effect<number, CliConfigError> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return new CliConfigError({ message: "Port must be an integer from 1 to 65535." });
  }

  return Effect.succeed(port);
}

function parsePoolSize(poolOption: number | undefined): Effect.Effect<number, CliConfigError> {
  if (poolOption === undefined) {
    return Effect.succeed(DEFAULT_LOCAL_CLIENT_POOL_SIZE);
  }

  if (!Number.isInteger(poolOption) || poolOption < 1 || poolOption > 16) {
    return new CliConfigError({ message: "Pool size must be an integer from 1 to 16." });
  }

  return Effect.succeed(poolOption);
}
