import { Buffer } from "node:buffer";

import type { HeaderPair } from "@turbotunnel/contracts";
import { Effect, Stream } from "effect";

import { LocalHttpRequestFailed, LocalHttpResponseTooLarge } from "../errors.js";

export type LocalHttpResponse = {
  readonly status: number;
  readonly headers: ReadonlyArray<HeaderPair>;
  readonly body: Uint8Array;
};

/** Keeps Fetch and Web Stream platform types at the local HTTP adapter boundary. */
export const requestLocalHttp = Effect.fn("requestLocalHttp")(function* (options: {
  readonly url: URL;
  readonly method: string;
  readonly headers: ReadonlyArray<HeaderPair>;
  readonly body: Uint8Array | undefined;
  readonly maxResponseBytes: number;
  readonly host: string;
  readonly port: number;
}): Effect.fn.Return<LocalHttpResponse, LocalHttpRequestFailed | LocalHttpResponseTooLarge> {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      globalThis.fetch(options.url, {
        method: options.method,
        headers: options.headers.map(([name, value]) => [name, value] as [string, string]),
        body: options.body === undefined ? undefined : new Uint8Array(options.body),
        signal,
      }),
    catch: (cause) => requestFailed(options.host, options.port, cause),
  });
  const body =
    response.body === null
      ? Buffer.alloc(0)
      : yield* Stream.fromReadableStream({
          evaluate: () => response.body!,
          onError: (cause) => requestFailed(options.host, options.port, cause),
        }).pipe(
          Stream.runFoldEffect(
            () => ({ bytes: 0, chunks: [] as Array<Buffer> }),
            (acc, chunk) => {
              const bytes = acc.bytes + chunk.byteLength;
              if (bytes > options.maxResponseBytes) {
                return Effect.fail(
                  new LocalHttpResponseTooLarge({
                    limitBytes: options.maxResponseBytes,
                    message: "Local app response exceeded the tunnel response size limit.",
                  }),
                );
              }
              acc.chunks.push(Buffer.from(chunk));
              return Effect.succeed({ bytes, chunks: acc.chunks });
            },
          ),
          Effect.map(({ bytes, chunks }) => Buffer.concat(chunks, bytes)),
        );

  const headers: Array<HeaderPair> = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return { status: response.status, headers, body };
});

function requestFailed(host: string, port: number, cause: unknown): LocalHttpRequestFailed {
  return new LocalHttpRequestFailed({
    host,
    port,
    cause,
    message: `Local app request failed at http://${host}:${port}. Confirm the app is listening there, or restart the tunnel with --host <host>.`,
  });
}
