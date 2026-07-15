import { Effect } from "effect";
import { describe, expect, test } from "vitest";

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
  test("round trips an outbound frame through schema-backed JSON", async () => {
    const frame = validHttpRequestFrame();

    const decoded = await Effect.runPromise(
      encodeProtocolFrameJson(frame).pipe(Effect.flatMap(decodeProtocolFrameJson)),
    );

    expect(decoded).toEqual(frame);
  });

  test("exposes malformed JSON and invalid payloads as separate catchable tags", async () => {
    const malformedTag = await Effect.runPromise(
      decodeProtocolFrameJson("{ nope").pipe(
        Effect.catchTags({
          ProtocolJsonDecodeError: (error) => Effect.succeed(error._tag),
          ProtocolPayloadDecodeError: (error) => Effect.succeed(error._tag),
        }),
      ),
    );
    const payloadTag = await Effect.runPromise(
      decodeProtocolFrameJson(JSON.stringify({ type: "unknown.frame" })).pipe(
        Effect.catchTags({
          ProtocolJsonDecodeError: (error) => Effect.succeed(error._tag),
          ProtocolPayloadDecodeError: (error) => Effect.succeed(error._tag),
        }),
      ),
    );

    expect(malformedTag).toBe("ProtocolJsonDecodeError");
    expect(payloadTag).toBe("ProtocolPayloadDecodeError");
  });

  test("retains tagged error classes in the Effect failure channel", async () => {
    const jsonError = await Effect.runPromise(Effect.flip(decodeProtocolFrameJson("{")));
    const payloadError = await Effect.runPromise(
      Effect.flip(decodeProtocolFramePayload({ ...validHttpRequestFrame(), extra: true })),
    );

    expect(jsonError).toBeInstanceOf(ProtocolJsonDecodeError);
    expect(payloadError).toBeInstanceOf(ProtocolPayloadDecodeError);
    expect(payloadError.expected).toBe("protocol frame");
  });

  test("rejects runtime-invalid outbound values before encoding", async () => {
    const invalidFrame = { ...validHttpRequestFrame(), protocolVersion: 2 } as unknown as Frame;

    const error = await Effect.runPromise(Effect.flip(encodeProtocolFrameJson(invalidFrame)));

    expect(error).toBeInstanceOf(ProtocolJsonEncodeError);
  });
});

describe("directional protocol decoders", () => {
  test("accepts frames expected by each endpoint", async () => {
    const toLocalJson = await Effect.runPromise(encodeProtocolFrameJson(validWsDataToLocalFrame()));
    const toGatewayJson = await Effect.runPromise(
      encodeProtocolFrameJson(validWsDataToBrowserFrame()),
    );
    const toLocal = await Effect.runPromise(decodeLocalClientInboundFrameJson(toLocalJson));
    const toGateway = await Effect.runPromise(decodeGatewayInboundFrameJson(toGatewayJson));

    expect(toLocal.type).toBe("ws.data");
    expect(toGateway.type).toBe("ws.data");
  });

  test("requires the routing topic for the decoded WebSocket direction", async () => {
    const unroutable = {
      ...validWsDataToLocalFrame(),
      localInTopic: undefined,
    };

    const directionalError = await Effect.runPromise(
      Effect.flip(decodeLocalClientInboundFrameJson(JSON.stringify(unroutable))),
    );
    const broadFrame = await Effect.runPromise(decodeProtocolFrameJson(JSON.stringify(unroutable)));

    expect(directionalError).toBeInstanceOf(ProtocolPayloadDecodeError);
    expect(broadFrame.type).toBe("ws.data");
  });

  test("rejects a valid frame sent in the wrong direction", async () => {
    const error = await Effect.runPromise(
      Effect.flip(decodeGatewayInboundFrameJson(JSON.stringify(validHttpRequestFrame()))),
    );

    expect(error).toBeInstanceOf(ProtocolPayloadDecodeError);
    if (error._tag === "ProtocolPayloadDecodeError") {
      expect(error.expected).toBe("gateway inbound frame");
    }
  });

  test("decodes the exact HTTP response queue subset", async () => {
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

    const decoded = await Effect.runPromise(decodeHttpResponseFramePayload(response));
    const error = await Effect.runPromise(
      Effect.flip(decodeHttpResponseFramePayload(validHttpRequestFrame())),
    );

    expect(decoded).toEqual(response);
    expect(error).toBeInstanceOf(ProtocolPayloadDecodeError);
  });
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
