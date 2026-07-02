import { Schema } from "effect";

import { PROTOCOL_VERSION } from "./constants.js";

const nonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const portSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const statusCodeSchema = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }));
const wsCloseCodeSchema = Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 4999 }));

export const headerPairSchema = Schema.Tuple([Schema.String, Schema.String]);

const baseFrameFields = {
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  frameId: Schema.NonEmptyString,
  deadlineAt: Schema.optionalKey(positiveIntSchema),
};

export const baseFrameSchema = Schema.Struct(baseFrameFields);

export const localClientHelloSchema = Schema.Struct({
  type: Schema.Literal("local.hello"),
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  frameId: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  localClientId: Schema.NonEmptyString,
  target: Schema.Struct({
    protocol: Schema.Literal("http"),
    host: Schema.NonEmptyString,
    port: portSchema,
  }),
});

export const localClientHeartbeatSchema = Schema.Struct({
  type: Schema.Literal("local.heartbeat"),
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  frameId: Schema.NonEmptyString,
  localClientId: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  lastSeen: nonNegativeIntSchema,
});

export const httpRequestSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("http.request"),
  requestId: Schema.NonEmptyString,
  responseTopic: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  headers: Schema.Array(headerPairSchema),
  body: Schema.String,
});

export const httpResponseSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("http.response"),
  requestId: Schema.NonEmptyString,
  responseTopic: Schema.NonEmptyString,
  status: statusCodeSchema,
  headers: Schema.Array(headerPairSchema),
  body: Schema.String,
});

export const wsOpenSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("ws.open"),
  connId: Schema.NonEmptyString,
  browserOutTopic: Schema.NonEmptyString,
  localInTopic: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  headers: Schema.Array(headerPairSchema),
});

export const wsDataSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("ws.data"),
  connId: Schema.NonEmptyString,
  browserOutTopic: Schema.optionalKey(Schema.NonEmptyString),
  localInTopic: Schema.optionalKey(Schema.NonEmptyString),
  seq: nonNegativeIntSchema,
  data: Schema.String,
  binary: Schema.Boolean,
});

export const wsCloseSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("ws.close"),
  connId: Schema.NonEmptyString,
  browserOutTopic: Schema.optionalKey(Schema.NonEmptyString),
  localInTopic: Schema.optionalKey(Schema.NonEmptyString),
  code: Schema.optionalKey(wsCloseCodeSchema),
  reason: Schema.optionalKey(Schema.String),
});

export const deliveryAckSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("delivery.ack"),
  ackFrameId: Schema.NonEmptyString,
});

export const deliveryRejectSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("delivery.reject"),
  rejectFrameId: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
});

export const errorFrameSchema = Schema.Struct({
  ...baseFrameFields,
  type: Schema.Literal("error"),
  requestId: Schema.optionalKey(Schema.String),
  connId: Schema.optionalKey(Schema.String),
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
});

export const frameSchema = Schema.Union([
  localClientHelloSchema,
  localClientHeartbeatSchema,
  httpRequestSchema,
  httpResponseSchema,
  wsOpenSchema,
  wsDataSchema,
  wsCloseSchema,
  deliveryAckSchema,
  deliveryRejectSchema,
  errorFrameSchema,
]).pipe(Schema.toTaggedUnion("type"));

export const isHttpResponseFrame = frameSchema.isAnyOf(["http.response"]);
export const isTunnelRequestFrame = frameSchema.isAnyOf([
  "http.request",
  "ws.open",
  "ws.data",
  "ws.close",
]);

export type HeaderPair = Schema.Schema.Type<typeof headerPairSchema>;
export type BaseFrame = Schema.Schema.Type<typeof baseFrameSchema>;
export type LocalClientHello = Schema.Schema.Type<typeof localClientHelloSchema>;
export type LocalClientHeartbeat = Schema.Schema.Type<typeof localClientHeartbeatSchema>;
export type HttpRequest = Schema.Schema.Type<typeof httpRequestSchema>;
export type HttpResponse = Schema.Schema.Type<typeof httpResponseSchema>;
export type WsOpen = Schema.Schema.Type<typeof wsOpenSchema>;
export type WsData = Schema.Schema.Type<typeof wsDataSchema>;
export type WsClose = Schema.Schema.Type<typeof wsCloseSchema>;
export type DeliveryAck = Schema.Schema.Type<typeof deliveryAckSchema>;
export type DeliveryReject = Schema.Schema.Type<typeof deliveryRejectSchema>;
export type ErrorFrame = Schema.Schema.Type<typeof errorFrameSchema>;
export type Frame = Schema.Schema.Type<typeof frameSchema>;
export type TunnelRequestFrame = HttpRequest | WsOpen | WsData | WsClose;
