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

export const resolveAccessPolicy = Effect.fn("resolveAccessPolicy")(function* (options: {
  readonly configured?: ProjectAccess;
  readonly override?: AccessOverride;
  readonly interactive: boolean;
}): Effect.fn.Return<AccessPolicy, CliConfigError> {
  const selected = options.override ?? options.configured ?? { type: "public" as const };
  switch (selected.type) {
    case "public":
      return { type: "public" };
    case "ip": {
      if (selected.allow.length === 0) {
        return yield* new CliConfigError({
          message: "IP access requires at least one address or CIDR. No tunnel was made public.",
        });
      }
      const cidrs = yield* Effect.forEach(selected.allow, (cidr) => normalizeCidr(cidr));
      return { type: "ipAllowlist", cidrs: cidrs as [string, ...Array<string>] };
    }
    case "password": {
      const inline = options.override?.type === "password" ? options.override.password : undefined;
      const password = yield* resolvePasswordSecret({
        inline,
        interactive: options.interactive,
      });
      return { type: "password", hash: yield* hashPassword(password) };
    }
  }
});

function resolvePasswordSecret(options: {
  readonly inline: string | undefined;
  readonly interactive: boolean;
}): Effect.Effect<string, CliConfigError> {
  const inline = nonEmpty(options.inline);
  if (inline !== undefined) return Effect.succeed(inline);
  if (options.interactive) return promptPassword;
  return Effect.fail(
    new CliConfigError({
      message:
        "Password access needs a secret. Pass --password <value> or run in a TTY to be prompted. No tunnel was made public.",
    }),
  );
}

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

const promptPassword: Effect.Effect<string, CliConfigError> = Effect.gen(function* () {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    return yield* new CliConfigError({
      message:
        "Password access needs a secret. Pass --password <value> or run in a TTY to be prompted. No tunnel was made public.",
    });
  }
  const input = process.stdin;
  const wasRaw = input.isRaw;
  yield* Effect.try({
    try: () => {
      process.stdout.write("Tunnel password: ");
      input.setRawMode(true);
    },
    catch: (cause) =>
      new CliConfigError({
        message: `Couldn't read a tunnel password from this terminal (${cause instanceof Error ? cause.message : String(cause)}). Pass --password <value>. No tunnel was made public.`,
      }),
  });
  return yield* Effect.callback<string, CliConfigError>((resume) => {
    let password = "";
    let settled = false;
    const settle = (effect: Effect.Effect<string, CliConfigError>): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      process.stdout.write("\n");
      resume(effect);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        settle(
          Effect.fail(
            new CliConfigError({
              message: "Password entry was cancelled. No tunnel was made public.",
            }),
          ),
        );
        return;
      }
      if (text === "\r" || text === "\n") {
        if (password.length === 0) {
          settle(
            Effect.fail(
              new CliConfigError({
                message:
                  "Password access needs a non-empty password. Retry or pass --password <value>. No tunnel was made public.",
              }),
            ),
          );
          return;
        }
        settle(Effect.succeed(password));
        return;
      }
      if (text === "\u007f") {
        password = password.slice(0, -1);
        return;
      }
      password += text;
    };
    input.resume();
    input.on("data", onData);
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        input.off("data", onData);
      }
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        try {
          input.setRawMode?.(wasRaw);
        } catch {
          // restore is best-effort when stdin is already closed
        }
        input.pause();
      }),
    ),
  );
});
