import { Schema } from "effect";

export const TunnelLifecycleSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  pid: Schema.Number,
  state: Schema.Literals(["starting", "connecting", "ready", "reconnecting"]),
  startedAtMs: Schema.Number,
  publicUrl: Schema.String,
  localUrl: Schema.String,
  gatewayStatusUrl: Schema.String,
  configuredRelays: Schema.Number,
  connectedRelays: Schema.Number,
  relayConnects: Schema.Number,
  relayCloses: Schema.Number,
  relayErrors: Schema.Number,
  reconnects: Schema.Number,
  framesReceived: Schema.Number,
  framesSent: Schema.Number,
  invalidFrames: Schema.Number,
  httpRequests: Schema.Number,
  httpResponses: Schema.Number,
  webSocketsOpened: Schema.Number,
  webSocketsClosed: Schema.Number,
});

export type TunnelLifecycleSnapshot = typeof TunnelLifecycleSnapshotSchema.Type;

export const RuntimeRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]+$/)),
  pid: Schema.Number,
  processToken: Schema.String,
  startedAt: Schema.Number,
  slug: Schema.String,
  publicUrl: Schema.String,
  localUrl: Schema.String,
  controlSocketPath: Schema.String,
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
