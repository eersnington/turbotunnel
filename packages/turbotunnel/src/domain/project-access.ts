import { randomBytes, scrypt as nodeScrypt } from "node:crypto";

import {
  ACCESS_SCRYPT_N,
  ACCESS_SCRYPT_P,
  ACCESS_SCRYPT_R,
  normalizeCidr as normalizeSharedCidr,
  type AccessPolicy,
} from "@turbotunnel/contracts";
import { Effect } from "effect";

import type { ProjectAccess } from "../adapters/project-config-store.js";
import { CliConfigError } from "../errors.js";

export type AccessOverride =
  | { readonly type: "public" }
  | { readonly type: "password"; readonly password?: string }
  | { readonly type: "ip"; readonly allow: ReadonlyArray<string> };

export type ResolvedAccess =
  | {
      readonly policy: Extract<AccessPolicy, { readonly type: "password" }>;
      readonly password: string;
    }
  | {
      readonly policy: Exclude<AccessPolicy, { readonly type: "password" }>;
      readonly password?: never;
    };

/** Resolves the configured or temporary access policy and its one-time display credential. */
export const resolveAccessPolicy = Effect.fn("resolveAccessPolicy")(function* (options: {
  readonly configured?: ProjectAccess;
  readonly override?: AccessOverride;
  readonly generatedPassword: string;
}): Effect.fn.Return<ResolvedAccess, CliConfigError> {
  const selected = options.override ?? options.configured ?? { type: "public" as const };
  switch (selected.type) {
    case "public":
      return { policy: { type: "public" } };
    case "ip": {
      if (selected.allow.length === 0) {
        return yield* new CliConfigError({
          message: "IP access requires at least one address or CIDR. No tunnel was made public.",
        });
      }
      const cidrs = yield* Effect.forEach(selected.allow, (cidr) => normalizeCidr(cidr));
      return { policy: { type: "ipAllowlist", cidrs: cidrs as [string, ...Array<string>] } };
    }
    case "password": {
      const inline = options.override?.type === "password" ? options.override.password : undefined;
      const password = nonEmpty(inline) ?? options.generatedPassword;
      return {
        policy: { type: "password", hash: yield* hashPassword(password) },
        password,
      };
    }
  }
});

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function normalizeCidr(value: string): Effect.Effect<string, CliConfigError> {
  const normalized = normalizeSharedCidr(value);
  if (normalized === undefined) {
    return Effect.fail(
      new CliConfigError({
        message: `Invalid IP allowlist entry ${JSON.stringify(value)}. Use a valid IPv4 or IPv6 address or CIDR. IPv4-mapped IPv6 is not supported. No tunnel was made public.`,
      }),
    );
  }
  return Effect.succeed(normalized);
}

const hashPassword = Effect.fn("ProjectAccess.hashPassword")(function* (password: string) {
  const salt = randomBytes(16);
  // Bun's async scrypt success uses `undefined` for error (Node uses `null`); require a key.
  const derived = yield* Effect.callback<Buffer, CliConfigError>((resume) => {
    nodeScrypt(
      password,
      salt,
      32,
      { N: ACCESS_SCRYPT_N, r: ACCESS_SCRYPT_R, p: ACCESS_SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error != null || key == null) {
          const detail = error instanceof Error ? error.message : "unknown scrypt failure";
          resume(
            Effect.fail(
              new CliConfigError({
                message: `Couldn't derive the tunnel password hash (${detail}). Retry with a different password. No tunnel was made public.`,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed(key));
      },
    );
  });
  return `scrypt$1$${ACCESS_SCRYPT_N}$${ACCESS_SCRYPT_R}$${ACCESS_SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
});
