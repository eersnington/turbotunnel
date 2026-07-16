import { Schema } from "effect";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const TunnelLifecycleSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  pid: positiveInt,
  state: Schema.Literals(["starting", "connecting", "ready", "reconnecting"]),
  startedAtMs: nonNegativeInt,
  publicUrl: Schema.NonEmptyString,
  localUrl: Schema.NonEmptyString,
  gatewayStatusUrl: Schema.NonEmptyString,
  configuredRelays: positiveInt,
  connectedRelays: nonNegativeInt,
  relayConnects: nonNegativeInt,
  relayCloses: nonNegativeInt,
  relayErrors: nonNegativeInt,
  reconnects: nonNegativeInt,
  framesReceived: nonNegativeInt,
  framesSent: nonNegativeInt,
  invalidFrames: nonNegativeInt,
  httpRequests: nonNegativeInt,
  httpResponses: nonNegativeInt,
  webSocketsOpened: nonNegativeInt,
  webSocketsClosed: nonNegativeInt,
});

export type TunnelLifecycleSnapshot = typeof TunnelLifecycleSnapshotSchema.Type;

export const RuntimeRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]+$/)),
  pid: positiveInt,
  processToken: Schema.NonEmptyString,
  startedAt: nonNegativeInt,
  slug: Schema.NonEmptyString,
  publicUrl: Schema.NonEmptyString,
  localUrl: Schema.NonEmptyString,
  controlSocketPath: Schema.NonEmptyString,
});

export type RuntimeRecord = typeof RuntimeRecordSchema.Type;

export const decodeRuntimeRecord = Schema.decodeUnknownEffect(RuntimeRecordSchema, {
  onExcessProperty: "error",
});

export const ControlRequestSchema = Schema.Struct({
  version: Schema.Literal(1),
  processToken: Schema.String,
});

export const ControlResponseSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("ok"),
    snapshot: TunnelLifecycleSnapshotSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("error"),
    reason: Schema.Literals(["unauthorized", "invalid_request"]),
  }),
]);

export type ControlResponse = typeof ControlResponseSchema.Type;

export const decodeControlRequest = Schema.decodeUnknownEffect(ControlRequestSchema, {
  onExcessProperty: "error",
});

export const decodeControlResponse = Schema.decodeUnknownEffect(ControlResponseSchema, {
  onExcessProperty: "error",
});
