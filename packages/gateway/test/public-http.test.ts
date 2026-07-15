import { Buffer } from "node:buffer";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  readLimitedBody,
  RequestBodyReadError,
  RequestBodyTooLargeError,
} from "../src/public-http.js";

describe("public HTTP request bodies", () => {
  test("reports an oversized body in the typed error channel", async () => {
    const request = new IncomingMessage(new Socket());
    const result = Effect.runPromise(Effect.flip(readLimitedBody(request, 3)));

    request.emit("data", Buffer.from("four"));

    const error = await result;
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect(error).toMatchObject({ limitBytes: 3 });
  });

  test("reports a body stream failure in the typed error channel", async () => {
    const request = new IncomingMessage(new Socket());
    const result = Effect.runPromise(Effect.flip(readLimitedBody(request, 3)));

    request.emit("error", new Error("stream failed"));

    const error = await result;
    expect(error).toBeInstanceOf(RequestBodyReadError);
  });
});
