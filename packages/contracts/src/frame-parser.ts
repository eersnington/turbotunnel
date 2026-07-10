import { pipe, Result, Schema } from "effect";

import { type Frame, frameSchema } from "./frames.js";

export class ProtocolFrameParseError extends Schema.TaggedErrorClass<ProtocolFrameParseError>()(
  "ProtocolFrameParseError",
  {
    reason: Schema.Literals(["invalid-json", "invalid-frame"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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
