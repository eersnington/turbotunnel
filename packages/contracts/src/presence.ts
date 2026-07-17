import { Schema } from "effect";

import { accessPolicySchema } from "./access-policy.js";

const nonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const portSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export const tunnelTargetSchema = Schema.Struct({
  protocol: Schema.Literal("http"),
  host: Schema.NonEmptyString,
  port: portSchema,
});

/** Full relay state published for every presence transition. */
export const tunnelPresenceEventSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literals(["upsert", "refresh", "remove"]),
  slug: Schema.NonEmptyString,
  publicHost: Schema.NonEmptyString,
  accessPolicy: accessPolicySchema,
  sessionId: Schema.NonEmptyString,
  localClientId: Schema.NonEmptyString,
  generation: positiveIntSchema,
  sequence: positiveIntSchema,
  target: tunnelTargetSchema,
  connectedAt: nonNegativeIntSchema,
});

export const listedTunnelSchema = Schema.Struct({
  slug: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  target: tunnelTargetSchema,
  connectedAt: nonNegativeIntSchema,
  relayCount: positiveIntSchema,
});

/** Versioned bounded-consistency response returned by the gateway tunnel-list endpoint. */
export const tunnelListResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  consistency: Schema.Literal("bounded"),
  generatedAt: nonNegativeIntSchema,
  tunnels: Schema.Array(listedTunnelSchema),
});

export type TunnelPresenceEvent = Schema.Schema.Type<typeof tunnelPresenceEventSchema>;
export type ListedTunnel = Schema.Schema.Type<typeof listedTunnelSchema>;
export type TunnelListResponse = Schema.Schema.Type<typeof tunnelListResponseSchema>;
