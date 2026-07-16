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
}).check(
  Schema.makeFilter((snapshot) => {
    if (snapshot.connectedRelays > snapshot.configuredRelays) {
      return {
        path: ["connectedRelays"],
        issue: "connected relays must not exceed configured relays",
      };
    }
    if (snapshot.state === "starting" && snapshot.connectedRelays !== 0) {
      return { path: ["connectedRelays"], issue: "a starting tunnel cannot have connected relays" };
    }
    if (snapshot.state === "ready" && snapshot.connectedRelays !== snapshot.configuredRelays) {
      return { path: ["connectedRelays"], issue: "a ready tunnel must have all relays connected" };
    }
    if (
      (snapshot.state === "connecting" || snapshot.state === "reconnecting") &&
      snapshot.connectedRelays === snapshot.configuredRelays
    ) {
      return {
        path: ["connectedRelays"],
        issue: `${snapshot.state} tunnel must have fewer connected relays than configured relays`,
      };
    }
  }),
);

export type TunnelLifecycleSnapshot = typeof TunnelLifecycleSnapshotSchema.Type;

export const RuntimeRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]+$/)),
  pid: positiveInt,
  processToken: Schema.NonEmptyString,
  startedAt: nonNegativeInt,
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
