import { Schema } from "effect";

const scryptHashSchema = Schema.String.check(
  Schema.isPattern(/^scrypt\$1\$[1-9]\d*\$[1-9]\d*\$[1-9]\d*\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/),
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
    cidrs: Schema.NonEmptyArray(Schema.NonEmptyString),
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
