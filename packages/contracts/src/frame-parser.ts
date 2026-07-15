import { Effect, pipe, Result, Schema } from "effect";

import {
  type BrowserOutputFrame,
  browserOutputFrameSchema,
  type Frame,
  frameSchema,
  type GatewayInboundFrame,
  gatewayInboundFrameSchema,
  type HttpResponse,
  httpResponseSchema,
  type LocalClientInboundFrame,
  localClientInboundFrameSchema,
  type RoutableTunnelRequestFrame,
  tunnelRequestFrameSchema,
} from "./frames.js";

export class ProtocolJsonDecodeError extends Schema.TaggedErrorClass<ProtocolJsonDecodeError>()(
  "ProtocolJsonDecodeError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ProtocolPayloadDecodeError extends Schema.TaggedErrorClass<ProtocolPayloadDecodeError>()(
  "ProtocolPayloadDecodeError",
  {
    expected: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ProtocolJsonEncodeError extends Schema.TaggedErrorClass<ProtocolJsonEncodeError>()(
  "ProtocolJsonEncodeError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ProtocolFrameParseError extends Schema.TaggedErrorClass<ProtocolFrameParseError>()(
  "ProtocolFrameParseError",
  {
    reason: Schema.Literals(["invalid-json", "invalid-frame"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const strictDecodeOptions = { onExcessProperty: "error" } as const;
const decodeJsonValue = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeFrame = Schema.decodeUnknownEffect(frameSchema, strictDecodeOptions);
const decodeGatewayInboundFrame = Schema.decodeUnknownEffect(
  gatewayInboundFrameSchema,
  strictDecodeOptions,
);
const decodeLocalClientInboundFrame = Schema.decodeUnknownEffect(
  localClientInboundFrameSchema,
  strictDecodeOptions,
);
const decodeTunnelRequestFrame = Schema.decodeUnknownEffect(
  tunnelRequestFrameSchema,
  strictDecodeOptions,
);
const decodeBrowserOutputFrame = Schema.decodeUnknownEffect(
  browserOutputFrameSchema,
  strictDecodeOptions,
);
const decodeHttpResponseFrame = Schema.decodeUnknownEffect(httpResponseSchema, strictDecodeOptions);
const encodeFrameJson = Schema.encodeEffect(Schema.fromJsonString(frameSchema));

/** Decode JSON separately so callers can recover malformed JSON with catchTags. */
export function decodeProtocolFrameJson(
  text: string,
): Effect.Effect<Frame, ProtocolJsonDecodeError | ProtocolPayloadDecodeError> {
  return decodeProtocolJson(text).pipe(Effect.flatMap(decodeProtocolFramePayload));
}

export function decodeProtocolFramePayload(
  payload: unknown,
): Effect.Effect<Frame, ProtocolPayloadDecodeError> {
  return decodePayload(decodeFrame, payload, "protocol frame");
}

export function decodeGatewayInboundFrameJson(
  text: string,
): Effect.Effect<GatewayInboundFrame, ProtocolJsonDecodeError | ProtocolPayloadDecodeError> {
  return decodeProtocolJson(text).pipe(Effect.flatMap(decodeGatewayInboundFramePayload));
}

export function decodeGatewayInboundFramePayload(
  payload: unknown,
): Effect.Effect<GatewayInboundFrame, ProtocolPayloadDecodeError> {
  return decodePayload(decodeGatewayInboundFrame, payload, "gateway inbound frame");
}

export function decodeLocalClientInboundFrameJson(
  text: string,
): Effect.Effect<LocalClientInboundFrame, ProtocolJsonDecodeError | ProtocolPayloadDecodeError> {
  return decodeProtocolJson(text).pipe(Effect.flatMap(decodeLocalClientInboundFramePayload));
}

export function decodeLocalClientInboundFramePayload(
  payload: unknown,
): Effect.Effect<LocalClientInboundFrame, ProtocolPayloadDecodeError> {
  return decodePayload(decodeLocalClientInboundFrame, payload, "local-client inbound frame");
}

export function decodeTunnelRequestFramePayload(
  payload: unknown,
): Effect.Effect<RoutableTunnelRequestFrame, ProtocolPayloadDecodeError> {
  return decodePayload(decodeTunnelRequestFrame, payload, "tunnel request frame");
}

export function decodeBrowserOutputFramePayload(
  payload: unknown,
): Effect.Effect<BrowserOutputFrame, ProtocolPayloadDecodeError> {
  return decodePayload(decodeBrowserOutputFrame, payload, "browser output frame");
}

export function decodeHttpResponseFramePayload(
  payload: unknown,
): Effect.Effect<HttpResponse, ProtocolPayloadDecodeError> {
  return decodePayload(decodeHttpResponseFrame, payload, "HTTP response frame");
}

/** Validate and encode an outbound frame using the same schema used for decoding. */
export function encodeProtocolFrameJson(
  frame: Frame,
): Effect.Effect<string, ProtocolJsonEncodeError> {
  return encodeFrameJson(frame).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolJsonEncodeError({
          message: "Protocol frame could not be encoded as JSON; no frame was sent.",
          cause,
        }),
    ),
  );
}

function decodeProtocolJson(text: string): Effect.Effect<unknown, ProtocolJsonDecodeError> {
  return decodeJsonValue(text).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolJsonDecodeError({
          message: "Protocol frame JSON could not be parsed; the frame was discarded.",
          cause,
        }),
    ),
  );
}

function decodePayload<A>(
  decode: (payload: unknown) => Effect.Effect<A, Schema.SchemaError>,
  payload: unknown,
  expected: string,
): Effect.Effect<A, ProtocolPayloadDecodeError> {
  return decode(payload).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolPayloadDecodeError({
          expected,
          message: `Protocol payload did not match the expected ${expected}; the frame was discarded.`,
          cause,
        }),
    ),
  );
}

export function parseProtocolFrameJson(
  text: string,
): Result.Result<Frame, ProtocolFrameParseError> {
  return pipe(
    Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(text),
    Result.mapError(
      (cause) =>
        new ProtocolFrameParseError({
          reason: "invalid-json",
          message: "Protocol frame JSON could not be parsed; the frame was discarded.",
          cause,
        }),
    ),
    Result.flatMap(parseProtocolFramePayload),
  );
}

export function parseProtocolFramePayload(
  payload: unknown,
): Result.Result<Frame, ProtocolFrameParseError> {
  return pipe(
    Schema.decodeUnknownResult(frameSchema, { onExcessProperty: "error" })(payload),
    Result.mapError(
      (cause) =>
        new ProtocolFrameParseError({
          reason: "invalid-frame",
          message:
            "Protocol frame payload did not match the Turbotunnel frame schema; the frame was discarded.",
          cause,
        }),
    ),
  );
}
