import { createHmac, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  ACCESS_SCRYPT_N,
  ACCESS_SCRYPT_P,
  ACCESS_SCRYPT_R,
  addressInCidr,
  isSupportedCidr,
  type AccessPolicy,
} from "@turbotunnel/contracts";
import { Effect, Redacted } from "effect";

import type { GatewayConfig } from "./gateway-config.js";
import type { GatewayRequestHeaders } from "./headers.js";

export const GATEWAY_COOKIE_NAME = "__Host-turbotunnel";
const ACCESS_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Pure public-traffic admission for cookie, IP allowlist, and open policies. */
export function admitPublicAccess(
  policy: AccessPolicy,
  host: string,
  headers: GatewayRequestHeaders,
  config: GatewayConfig["Service"],
): boolean {
  switch (policy.type) {
    case "public":
      return true;
    case "password":
      return hasValidAccessCookie(
        headers.cookie,
        host,
        policy.hash,
        Redacted.value(config.relaySecret),
      );
    case "ipAllowlist": {
      const address = clientIp(headers, config.brokerKind);
      return address !== undefined && policy.cidrs.some((cidr) => addressInCidr(address, cidr));
    }
  }
}

export function makeAccessCookie(host: string, hash: string, secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_COOKIE_MAX_AGE_SECONDS;
  const value = cookieValue(host, hash, expiresAt, secret);
  return `${GATEWAY_COOKIE_NAME}=${value}; Path=/; Max-Age=${ACCESS_COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

export function verifyScryptPassword(password: string, encoded: string): Effect.Effect<boolean> {
  const parsed = parseScryptHash(encoded);
  if (parsed === undefined) return Effect.succeed(false);
  return Effect.callback<boolean>((resume) => {
    nodeScrypt(
      password,
      parsed.salt,
      parsed.expected.byteLength,
      { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        resume(
          Effect.succeed(
            error === null &&
              derived.byteLength === parsed.expected.byteLength &&
              timingSafeEqual(derived, parsed.expected),
          ),
        );
      },
    );
    return Effect.void;
  });
}

export function isValidAccessPolicy(policy: AccessPolicy): boolean {
  switch (policy.type) {
    case "public":
      return true;
    case "password":
      return parseScryptHash(policy.hash) !== undefined;
    case "ipAllowlist":
      return policy.cidrs.every(isSupportedCidr);
  }
}

function clientIp(
  headers: GatewayRequestHeaders,
  brokerKind: GatewayConfig["Service"]["brokerKind"],
): string | undefined {
  // Only platform-injected proxy headers are trusted. Memory/local brokers do not admit
  // client-supplied X-Real-IP / X-Forwarded-For for allowlists.
  if (brokerKind !== "vercel") return undefined;
  const candidate = headers.realIp ?? headers.forwardedFor?.split(",", 1)[0]?.trim();
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : undefined;
}

function hasValidAccessCookie(
  cookieHeader: string | undefined,
  host: string,
  hash: string,
  secret: string,
): boolean {
  if (cookieHeader === undefined) return false;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== GATEWAY_COOKIE_NAME) continue;
    const actual = rest.join("=");
    const [version, expiresText, signature, excess] = actual.split(".");
    const expiresAt = Number(expiresText);
    if (
      version !== "v1" ||
      excess !== undefined ||
      signature === undefined ||
      !Number.isInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1000)
    )
      return false;
    const expected = cookieValue(host, hash, expiresAt, secret);
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return (
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actualBytes, expectedBytes)
    );
  }
  return false;
}

function cookieValue(host: string, hash: string, expiresAt: number, secret: string): string {
  const signingKey = createHmac("sha256", secret).update("turbotunnel/access-cookie/v1").digest();
  const signature = createHmac("sha256", signingKey)
    .update(`${host}\0${hash}\0${expiresAt}`)
    .digest("base64url");
  return `v1.${expiresAt}.${signature}`;
}

function parseScryptHash(encoded: string):
  | {
      readonly N: number;
      readonly r: number;
      readonly p: number;
      readonly salt: Buffer;
      readonly expected: Buffer;
    }
  | undefined {
  const [algorithm, version, nText, rText, pText, saltText, hashText, excess] = encoded.split("$");
  if (algorithm !== "scrypt" || version !== "1" || excess !== undefined) return undefined;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (
    N !== ACCESS_SCRYPT_N ||
    r !== ACCESS_SCRYPT_R ||
    p !== ACCESS_SCRYPT_P ||
    saltText === undefined ||
    hashText === undefined
  )
    return undefined;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  if (salt.byteLength < 8 || expected.byteLength < 16 || expected.byteLength > 128)
    return undefined;
  return { N, r, p, salt, expected };
}
