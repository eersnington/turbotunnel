import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import { isIP } from "node:net";

import type { AccessPolicy } from "@turbotunnel/contracts";
import { Effect } from "effect";

import type { ProjectAccess } from "../adapters/project-config-store.js";
import { CliConfigError } from "../errors.js";

export type AccessOverride =
  | { readonly type: "public" }
  | { readonly type: "password" }
  | { readonly type: "ip"; readonly allow: ReadonlyArray<string> };

export function accessOverrideFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AccessOverride | undefined, CliConfigError> {
  const type = environment.TURBOTUNNEL_ACCESS;
  if (type === undefined) return Effect.succeed(undefined);
  if (type === "public") return Effect.succeed({ type: "public" });
  if (type === "password") return Effect.succeed({ type: "password" });
  if (type === "ip") {
    const allow =
      environment.TURBOTUNNEL_ALLOW_IP?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    return Effect.succeed({ type: "ip", allow });
  }
  return Effect.fail(
    new CliConfigError({
      message: "TURBOTUNNEL_ACCESS must be public, password, or ip. No tunnel was started.",
    }),
  );
}

export const resolveAccessPolicy = Effect.fn("resolveAccessPolicy")(function* (options: {
  readonly configured?: ProjectAccess;
  readonly override?: AccessOverride;
  readonly password?: string;
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
      const password =
        options.password ?? (options.interactive ? yield* promptPassword : undefined);
      if (password === undefined || password.length === 0) {
        return yield* new CliConfigError({
          message:
            "Password access requires TURBOTUNNEL_PASSWORD when the terminal cannot prompt. No tunnel was made public.",
        });
      }
      return { type: "password", hash: yield* hashPassword(password) };
    }
  }
});

function normalizeCidr(value: string): Effect.Effect<string, CliConfigError> {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("/");
  const address = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const version = isIP(address);
  const prefix =
    separator === -1
      ? version === 4
        ? 32
        : version === 6
          ? 128
          : -1
      : Number(trimmed.slice(separator + 1));
  const maximum = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (maximum === -1 || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
    return Effect.fail(
      new CliConfigError({
        message: `Invalid IP allowlist entry ${JSON.stringify(value)}. Use a valid IPv4 or IPv6 address or CIDR. No tunnel was made public.`,
      }),
    );
  }
  return Effect.succeed(`${address}/${prefix}`);
}

const hashPassword = Effect.fn("ProjectAccess.hashPassword")(function* (password: string) {
  const salt = randomBytes(16);
  const derived = yield* Effect.callback<Buffer>((resume) => {
    nodeScrypt(
      password,
      salt,
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        resume(error === null ? Effect.succeed(key) : Effect.die(error));
      },
    );
  });
  return `scrypt$1$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
});

const promptPassword = Effect.callback<string, CliConfigError>((resume) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    resume(
      Effect.fail(
        new CliConfigError({
          message:
            "Password access requires TURBOTUNNEL_PASSWORD when the terminal cannot prompt. No tunnel was made public.",
        }),
      ),
    );
    return Effect.void;
  }
  const input = process.stdin;
  let password = "";
  const wasRaw = input.isRaw;
  const cleanup = (): void => {
    input.off("data", onData);
    input.setRawMode?.(wasRaw);
    input.pause();
  };
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (text === "\u0003") {
      cleanup();
      process.stdout.write("\n");
      resume(Effect.interrupt);
      return;
    }
    if (text === "\r" || text === "\n") {
      cleanup();
      process.stdout.write("\n");
      resume(Effect.succeed(password));
      return;
    }
    if (text === "\u007f") {
      password = password.slice(0, -1);
      return;
    }
    password += text;
  };
  process.stdout.write("Tunnel password: ");
  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  return Effect.sync(cleanup);
});
