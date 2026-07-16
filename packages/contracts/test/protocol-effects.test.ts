import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeGatewayInboundFrameJson,
  decodeHttpResponseFramePayload,
  decodeLocalClientInboundFrameJson,
  decodeProtocolFrameJson,
  decodeProtocolFramePayload,
  encodeProtocolFrameJson,
  type Frame,
  PROTOCOL_VERSION,
  ProtocolJsonDecodeError,
  ProtocolJsonEncodeError,
  ProtocolPayloadDecodeError,
} from "../src/index.js";

describe("Effect protocol codecs", () => {
  it.effect("round trips an outbound frame through schema-backed JSON", () =>
    Effect.gen(function* () {
      const frame = validHttpRequestFrame();

      const decoded = yield* encodeProtocolFrameJson(frame).pipe(
        Effect.flatMap(decodeProtocolFrameJson),
      );

      expect(decoded).toEqual(frame);
    }),
  );

  it.effect("exposes malformed JSON and invalid payloads as separate catchable tags", () =>
    Effect.gen(function* () {
      const malformedTag = yield* decodeProtocolFrameJson("{ nope").pipe(
        Effect.catchTags({
          ProtocolJsonDecodeError: (error) => Effect.succeed(error._tag),
          ProtocolPayloadDecodeError: (error) => Effect.succeed(error._tag),
        }),
      );
      const payloadTag = yield* decodeProtocolFrameJson(
        JSON.stringify({ type: "unknown.frame" }),
      ).pipe(
        Effect.catchTags({
          ProtocolJsonDecodeError: (error) => Effect.succeed(error._tag),
          ProtocolPayloadDecodeError: (error) => Effect.succeed(error._tag),
        }),
      );

      expect(malformedTag).toBe("ProtocolJsonDecodeError");
      expect(payloadTag).toBe("ProtocolPayloadDecodeError");
    }),
  );

  it.effect("retains tagged error classes in the Effect failure channel", () =>
    Effect.gen(function* () {
      const jsonError = yield* decodeProtocolFrameJson("{").pipe(Effect.flip);
      const payloadError = yield* decodeProtocolFramePayload({
        ...validHttpRequestFrame(),
        extra: true,
      }).pipe(Effect.flip);

      expect(jsonError).toBeInstanceOf(ProtocolJsonDecodeError);
      expect(payloadError).toBeInstanceOf(ProtocolPayloadDecodeError);
      expect(payloadError.expected).toBe("protocol frame");
    }),
  );

  it.effect("rejects runtime-invalid outbound values before encoding", () =>
    Effect.gen(function* () {
      const invalidFrame = { ...validHttpRequestFrame(), protocolVersion: 2 } as unknown as Frame;

      const error = yield* encodeProtocolFrameJson(invalidFrame).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProtocolJsonEncodeError);
    }),
  );
});

describe("directional protocol decoders", () => {
  it.effect("accepts local hello frames with and without session connectedAt", () =>
    Effect.gen(function* () {
      const hello = {
        type: "local.hello",
        protocolVersion: PROTOCOL_VERSION,
        frameId: "frm_hello",
        slug: "demo",
        localClientId: "client_1",
        sessionId: "session_1",
        generation: 1,
        capacity: 1,
        target: { protocol: "http", host: "127.0.0.1", port: 3000 },
      } as const;

      const compatible = yield* decodeGatewayInboundFrameJson(JSON.stringify(hello));
      const timestamped = yield* decodeGatewayInboundFrameJson(
        JSON.stringify({ ...hello, connectedAt: 1_000 }),
      );

      expect(compatible).not.toHaveProperty("connectedAt");
      expect(timestamped).toMatchObject({ connectedAt: 1_000 });
    }),
  );

  it.effect("accepts frames expected by each endpoint", () =>
    Effect.gen(function* () {
      const toLocalJson = yield* encodeProtocolFrameJson(validWsDataToLocalFrame());
      const toGatewayJson = yield* encodeProtocolFrameJson(validWsDataToBrowserFrame());
      const toLocal = yield* decodeLocalClientInboundFrameJson(toLocalJson);
      const toGateway = yield* decodeGatewayInboundFrameJson(toGatewayJson);

      expect(toLocal.type).toBe("ws.data");
      expect(toGateway.type).toBe("ws.data");
    }),
  );

  it.effect("requires the routing topic for the decoded WebSocket direction", () =>
    Effect.gen(function* () {
      const unroutable = {
        ...validWsDataToLocalFrame(),
        localInTopic: undefined,
      };

      const directionalError = yield* decodeLocalClientInboundFrameJson(
        JSON.stringify(unroutable),
      ).pipe(Effect.flip);
      const broadFrame = yield* decodeProtocolFrameJson(JSON.stringify(unroutable));

      expect(directionalError).toBeInstanceOf(ProtocolPayloadDecodeError);
      expect(broadFrame.type).toBe("ws.data");
    }),
  );

  it.effect("rejects a valid frame sent in the wrong direction", () =>
    Effect.gen(function* () {
      const error = yield* decodeGatewayInboundFrameJson(
        JSON.stringify(validHttpRequestFrame()),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProtocolPayloadDecodeError);
      if (error._tag === "ProtocolPayloadDecodeError") {
        expect(error.expected).toBe("gateway inbound frame");
      }
    }),
  );

  it.effect("decodes the exact HTTP response queue subset", () =>
    Effect.gen(function* () {
      const response = {
        type: "http.response",
        protocolVersion: PROTOCOL_VERSION,
        frameId: "frm_response_1",
        requestId: "req_1",
        responseTopic: "tt_res_req_1",
        status: 200,
        headers: [["content-type", "text/plain"]],
        body: "b2s=",
      } as const;

      const decoded = yield* decodeHttpResponseFramePayload(response);
      const error = yield* decodeHttpResponseFramePayload(validHttpRequestFrame()).pipe(
        Effect.flip,
      );

      expect(decoded).toEqual(response);
      expect(error).toBeInstanceOf(ProtocolPayloadDecodeError);
    }),
  );
});

function validHttpRequestFrame(): Frame {
  return {
    type: "http.request",
    protocolVersion: PROTOCOL_VERSION,
    frameId: "frm_1",
    requestId: "req_1",
    responseTopic: "tt_res_req_1",
    method: "GET",
    path: "/hello?name=tt",
    headers: [["accept", "text/plain"]],
    body: "",
  };
}

function validWsDataToLocalFrame() {
  return {
    type: "ws.data",
    protocolVersion: PROTOCOL_VERSION,
    frameId: "frm_local_1",
    connId: "conn_1",
    localInTopic: "tt_wsin_conn_1",
    seq: 0,
    data: "aGVsbG8=",
    binary: false,
  } as const;
}

function validWsDataToBrowserFrame() {
  return {
    type: "ws.data",
    protocolVersion: PROTOCOL_VERSION,
    frameId: "frm_browser_1",
    connId: "conn_1",
    browserOutTopic: "tt_wsout_conn_1",
    seq: 0,
    data: "aGVsbG8=",
    binary: false,
  } as const;
}
