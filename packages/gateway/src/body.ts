import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

export class BodyTooLargeError extends Error {
  readonly _tag = "BodyTooLargeError" as const;

  constructor(readonly limitBytes: number) {
    super(`Request body exceeded ${limitBytes} bytes`);
  }
}

export class BodyReadError extends Error {
  readonly _tag = "BodyReadError" as const;

  constructor(readonly cause: unknown) {
    super("Unable to read request body");
  }
}

export type ReadBodyError = BodyTooLargeError | BodyReadError;

/** Read an HTTP request body into memory with an explicit maximum size. */
export function readLimitedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Result<Buffer, ReadBodyError>> {
  return new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: Result<Buffer, ReadBodyError>): void => {
      if (settled) {
        return;
      }

      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;

      if (totalBytes > maxBytes) {
        request.pause();
        finish({ _tag: "err", error: new BodyTooLargeError(maxBytes) });
        return;
      }

      chunks.push(bytes);
    };

    const onEnd = (): void => {
      finish({ _tag: "ok", value: Buffer.concat(chunks, totalBytes) });
    };

    const onError = (cause: unknown): void => {
      finish({ _tag: "err", error: new BodyReadError(cause) });
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}
