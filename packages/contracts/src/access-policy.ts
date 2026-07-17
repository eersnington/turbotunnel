import { Schema } from "effect";

import { isSupportedCidr } from "./ip.js";

/** CLI-emitted scrypt parameters; gateway verify rejects any other cost. */
export const ACCESS_SCRYPT_N = 16_384;
export const ACCESS_SCRYPT_R = 8;
export const ACCESS_SCRYPT_P = 1;

const scryptHashSchema = Schema.String.check(
  Schema.isPattern(
    new RegExp(
      `^scrypt\\$1\\$${ACCESS_SCRYPT_N}\\$${ACCESS_SCRYPT_R}\\$${ACCESS_SCRYPT_P}\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]+$`,
    ),
  ),
);

const cidrSchema = Schema.NonEmptyString.check(
  Schema.makeFilter((value: string) => isSupportedCidr(value), {
    description: "IPv4 or non-mapped IPv6 CIDR",
  }),
);

/** Public traffic admission policy carried by a relay registration. */
export const accessPolicySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("public") }),
  Schema.Struct({
    type: Schema.Literal("password"),
    /** `scrypt$1$N$r$p$salt-base64url$derived-key-base64url`; plaintext is never sent. */
    hash: scryptHashSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("ipAllowlist"),
    cidrs: Schema.NonEmptyArray(cidrSchema),
  }),
]).pipe(Schema.toTaggedUnion("type"));

export type AccessPolicy = Schema.Schema.Type<typeof accessPolicySchema>;

/** Stable identity for a full hash-only access policy snapshot. */
export function accessPolicyFingerprint(policy: AccessPolicy): string {
  switch (policy.type) {
    case "public":
      return "policy-v1:public";
    case "password":
      return `policy-v1:password:${policy.hash}`;
    case "ipAllowlist":
      return `policy-v1:ip:${JSON.stringify([...policy.cidrs].sort())}`;
  }
}
