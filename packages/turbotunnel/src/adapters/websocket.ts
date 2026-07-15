import { Buffer } from "node:buffer";

import { encodeProtocolFrameJson, type Frame } from "@turbotunnel/contracts";
import { Cause, Effect, Queue, Scope } from "effect";
import { WebSocket, type RawData } from "ws";

import {
  LocalWebSocketConnectError,
  LocalWebSocketWriteError,
  RelayWebSocketConnectError,
  RelayWebSocketWriteError,
} from "../errors.js";

export type SocketEvent =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Message"; readonly data: Uint8Array; readonly binary: boolean }
  | { readonly _tag: "Close"; readonly code: number; readonly reason: string };

export type RelayWebSocket = {
  readonly receive: Effect.Effect<SocketEvent, RelayWebSocketConnectError>;
  readonly sendFrame: (frame: Frame) => Effect.Effect<void, RelayWebSocketWriteError>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
};

export type LocalWebSocket = {
  readonly receive: Effect.Effect<SocketEvent, LocalWebSocketConnectError>;
  readonly send: (
    data: Uint8Array | string,
    binary: boolean,
  ) => Effect.Effect<void, LocalWebSocketWriteError>;
  readonly close: (code: number | undefined, reason: string | undefined) => Effect.Effect<void>;
};

export function acquireRelayWebSocket(options: {
  readonly url: string;
  readonly protocol: string;
  readonly headers: Readonly<Record<string, string>>;
}): Effect.Effect<RelayWebSocket, RelayWebSocketConnectError, Scope.Scope> {
  return acquireSocket(
    options.url,
    () => new WebSocket(options.url, options.protocol, { headers: options.headers }),
    (cause) =>
      new RelayWebSocketConnectError({
        url: options.url,
        cause,
        message: `Relay WebSocket could not connect to ${options.url}; the tunnel will retry.`,
      }),
  ).pipe(
    Effect.map(({ socket, receive }) => ({
      receive,
      sendFrame: (frame) =>
        encodeProtocolFrameJson(frame).pipe(
          Effect.mapError(
            (cause) =>
              new RelayWebSocketWriteError({
                cause,
                message: "The relay frame could not be encoded; no frame was sent.",
              }),
          ),
          Effect.flatMap((encoded) =>
            sendSocket(
              socket,
              encoded,
              false,
              (cause) =>
                new RelayWebSocketWriteError({
                  cause,
                  message: "The relay WebSocket write did not complete; the connection will retry.",
                }),
            ),
          ),
        ),
      close: (code, reason) => closeSocket(socket, code, reason),
    })),
  );
}

export function acquireLocalWebSocket(options: {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
}): Effect.Effect<LocalWebSocket, LocalWebSocketConnectError, Scope.Scope> {
  return acquireSocket(
    options.url,
    () => new WebSocket(options.url, [...options.protocols], { headers: options.headers }),
    (cause) =>
      new LocalWebSocketConnectError({
        url: options.url,
        cause,
        message: "Tunnel could not connect to the local WebSocket endpoint.",
      }),
  ).pipe(
    Effect.map(({ socket, receive }) => ({
      receive,
      send: (data, binary) =>
        sendSocket(
          socket,
          typeof data === "string" ? data : Buffer.from(data),
          binary,
          (cause) =>
            new LocalWebSocketWriteError({
              cause,
              message: "The local WebSocket write did not complete; the connection was closed.",
            }),
        ),
      close: (code, reason) => closeSocket(socket, code, reason),
    })),
  );
}

function acquireSocket<E>(
  url: string,
  construct: () => WebSocket,
  connectError: (cause: unknown) => E,
): Effect.Effect<
  { readonly socket: WebSocket; readonly receive: Effect.Effect<SocketEvent, E> },
  E,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<SocketEvent, E>();
    const socket = yield* Effect.acquireRelease(
      Effect.try({ try: construct, catch: connectError }),
      (socket) =>
        Effect.sync(() => {
          socket.removeAllListeners();
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.once("error", () => {});
            socket.close();
          } else if (socket.readyState === WebSocket.OPEN) {
            socket.close(1001, "Turbotunnel scope closed");
          }
        }).pipe(Effect.andThen(Queue.shutdown(events))),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onOpen = (): void => {
          Queue.offerUnsafe(events, { _tag: "Open" });
        };
        const onMessage = (data: RawData, binary: boolean): void => {
          Queue.offerUnsafe(events, { _tag: "Message", data: rawDataToBuffer(data), binary });
        };
        const onClose = (code: number, reason: Buffer): void => {
          Queue.offerUnsafe(events, {
            _tag: "Close",
            code,
            reason: reason.toString("utf8"),
          });
        };
        const onError = (cause: Error): void => {
          Queue.failCauseUnsafe(events, Cause.fail(connectError(cause)));
        };
        socket.once("open", onOpen);
        socket.on("message", onMessage);
        socket.once("close", onClose);
        socket.once("error", onError);
        return { onOpen, onMessage, onClose, onError };
      }),
      ({ onOpen, onMessage, onClose, onError }) =>
        Effect.sync(() => {
          socket.removeListener("open", onOpen);
          socket.removeListener("message", onMessage);
          socket.removeListener("close", onClose);
          socket.removeListener("error", onError);
        }),
    );

    return { socket, receive: Queue.take(events) };
  });
}

function sendSocket<E>(
  socket: WebSocket,
  data: string | Buffer,
  binary: boolean,
  writeError: (cause: unknown) => E,
): Effect.Effect<void, E> {
  return Effect.callback((resume) => {
    if (socket.readyState !== WebSocket.OPEN) {
      resume(Effect.fail(writeError(new Error("WebSocket is not open."))));
      return;
    }
    try {
      socket.send(data, { binary }, (cause) => {
        resume(cause == null ? Effect.void : Effect.fail(writeError(cause)));
      });
    } catch (cause: unknown) {
      resume(Effect.fail(writeError(cause)));
    }
  });
}

function closeSocket(
  socket: WebSocket,
  code: number | undefined,
  reason: string | undefined,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}
