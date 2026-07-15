import { Buffer } from "node:buffer";

import { encodeProtocolFrameJson, type Frame } from "@turbotunnel/contracts";
import { Effect, Queue as EffectQueue, Schema, Scope } from "effect";
import { WebSocket, type RawData } from "ws";

/** Expected failure reported by the raw `ws` send callback. */
export class GatewayWebSocketWriteError extends Schema.TaggedErrorClass<GatewayWebSocketWriteError>()(
  "GatewayWebSocketWriteError",
  {
    operation: Schema.Literals(["send-frame", "send-data"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Inbound events emitted by a scoped gateway WebSocket. */
export type GatewayWebSocketEvent =
  | { readonly _tag: "Message"; readonly data: Buffer; readonly binary: boolean }
  | { readonly _tag: "Close"; readonly code: number; readonly reason: string };

/** Effect interface that hides raw `ws` listener and ready-state mechanics. */
export type GatewayWebSocket = {
  readonly receive: Effect.Effect<GatewayWebSocketEvent>;
  readonly isOpen: Effect.Effect<boolean>;
  readonly sendFrame: (frame: Frame) => Effect.Effect<boolean, GatewayWebSocketWriteError>;
  readonly sendData: (
    data: Buffer,
    binary: boolean,
  ) => Effect.Effect<boolean, GatewayWebSocketWriteError>;
  readonly close: (code: number | undefined, reason: string | undefined) => Effect.Effect<void>;
};

/** Adapts a raw `ws` connection into a scoped Effect queue and write capability. */
export function acquireGatewayWebSocket(
  ws: WebSocket,
): Effect.Effect<GatewayWebSocket, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* EffectQueue.make<GatewayWebSocketEvent>();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onMessage = (data: RawData, binary: boolean): void => {
          EffectQueue.offerUnsafe(events, {
            _tag: "Message",
            data: rawDataToBuffer(data),
            binary,
          });
        };
        const onClose = (code: number, reason: Buffer): void => {
          EffectQueue.offerUnsafe(events, {
            _tag: "Close",
            code,
            reason: reason.toString("utf8"),
          });
        };

        ws.on("message", onMessage);
        ws.once("close", onClose);
        return { onMessage, onClose };
      }),
      ({ onMessage, onClose }) =>
        Effect.sync(() => {
          ws.removeListener("message", onMessage);
          ws.removeListener("close", onClose);
        }).pipe(Effect.andThen(EffectQueue.shutdown(events))),
    );

    return {
      receive: EffectQueue.take(events),
      isOpen: Effect.sync(() => ws.readyState === WebSocket.OPEN),
      sendFrame: (frame) =>
        encodeProtocolFrameJson(frame).pipe(
          Effect.mapError(
            (cause) =>
              new GatewayWebSocketWriteError({
                operation: "send-frame",
                cause,
                message: "The gateway protocol frame could not be encoded; no frame was sent.",
              }),
          ),
          Effect.flatMap((encoded) => send(ws, "send-frame", encoded)),
        ),
      sendData: (data, binary) => send(ws, "send-data", data, { binary }),
      close: (code, reason) =>
        Effect.sync(() => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(code, reason);
          }
        }),
    };
  });
}

function send(
  ws: WebSocket,
  operation: "send-frame" | "send-data",
  data: string | Buffer,
  options?: { readonly binary: boolean },
): Effect.Effect<boolean, GatewayWebSocketWriteError> {
  return Effect.callback((resume) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resume(Effect.succeed(false));
      return;
    }

    const onSent = (cause?: Error): void => {
      resume(
        cause === undefined || cause === null
          ? Effect.succeed(true)
          : Effect.fail(
              new GatewayWebSocketWriteError({
                operation,
                cause,
                message: "The gateway WebSocket write did not complete.",
              }),
            ),
      );
    };
    try {
      if (options === undefined) {
        ws.send(data, onSent);
      } else {
        ws.send(data, options, onSent);
      }
    } catch (cause: unknown) {
      resume(
        Effect.fail(
          new GatewayWebSocketWriteError({
            operation,
            cause,
            message: "The gateway WebSocket write could not be started.",
          }),
        ),
      );
    }
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.concat(data);
}
