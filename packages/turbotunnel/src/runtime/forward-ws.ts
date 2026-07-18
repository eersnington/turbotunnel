import {
  decodeTunnelRequestTarget,
  type HeaderPair,
  makeLocalUrlFromTunnelRequestTarget,
  PROTOCOL_VERSION,
  type WsClose,
  type WsData,
  type WsOpen,
} from "@turbotunnel/contracts";
import { Deferred, Effect, Queue, Scope } from "effect";
import { nanoid } from "nanoid";

import { decodeBase64, decodeUtf8, encodeBase64 } from "../adapters/bytes.js";
import { acquireLocalWebSocket } from "../adapters/websocket.js";
import type { LocalTarget } from "../domain/tunnel-config.js";
import {
  LocalWebSocketConnectError,
  LocalWebSocketProtocolError,
  LocalWebSocketWriteError,
  RelayWebSocketWriteError,
} from "../errors.js";

type SendRelayFrame = (frame: WsData | WsClose) => Effect.Effect<void, RelayWebSocketWriteError>;

type LocalCommand =
  | { readonly _tag: "Data"; readonly frame: WsData }
  | { readonly _tag: "Close"; readonly frame: WsClose };

export const LOCAL_WEBSOCKET_COMMAND_QUEUE_CAPACITY = 256;

export type LocalWebSocketHandle = {
  readonly sendData: (frame: WsData) => Effect.Effect<void>;
  readonly close: (frame: WsClose) => Effect.Effect<void>;
  readonly closed: Effect.Effect<void>;
};

/** Opens and owns one local WebSocket for the current Scope. */
export const openLocalWebSocket = Effect.fn("openLocalWebSocket")(function* (
  frame: WsOpen,
  target: LocalTarget,
  sendRelayFrame: SendRelayFrame,
  options: { readonly commandQueueCapacity?: number } = {},
): Effect.fn.Return<
  LocalWebSocketHandle,
  LocalWebSocketProtocolError | RelayWebSocketWriteError,
  Scope.Scope
> {
  const requestTarget = yield* decodeTunnelRequestTarget(frame.path).pipe(
    Effect.mapError(
      (cause) =>
        new LocalWebSocketProtocolError({
          cause,
          message: cause.message,
        }),
    ),
    Effect.catchTag("LocalWebSocketProtocolError", (error) =>
      sendCloseFrame(frame, 1008, error.message, sendRelayFrame).pipe(
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
  const url = yield* makeLocalUrlFromTunnelRequestTarget({
    protocol: "ws",
    host: target.host,
    port: target.port,
    requestTarget,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalWebSocketProtocolError({
          cause,
          message: cause.message,
        }),
    ),
    Effect.catchTag("LocalWebSocketProtocolError", (error) =>
      sendCloseFrame(frame, 1008, error.message, sendRelayFrame).pipe(
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
  const commands = yield* Queue.bounded<LocalCommand>(
    options.commandQueueCapacity ?? LOCAL_WEBSOCKET_COMMAND_QUEUE_CAPACITY,
  );
  const overflow = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();

  yield* runLocalWebSocket(frame, url, commands, overflow, sendRelayFrame).pipe(
    Effect.catchTags({
      LocalWebSocketConnectError: () => sendLocalFailure(frame, sendRelayFrame),
      LocalWebSocketWriteError: () => sendLocalFailure(frame, sendRelayFrame),
      RelayWebSocketWriteError: () => Effect.void,
    }),
    Effect.ensuring(Deferred.succeed(closed, undefined)),
    Effect.forkScoped,
  );

  return {
    sendData: (dataFrame) =>
      offerLocalCommand(commands, overflow, { _tag: "Data", frame: dataFrame }),
    close: (closeFrame) =>
      offerLocalCommand(commands, overflow, { _tag: "Close", frame: closeFrame }),
    closed: Deferred.await(closed),
  };
});

const runLocalWebSocket = Effect.fn("runLocalWebSocket")(function* (
  frame: WsOpen,
  url: URL,
  commands: Queue.Queue<LocalCommand>,
  overflow: Deferred.Deferred<void>,
  sendRelayFrame: SendRelayFrame,
): Effect.fn.Return<
  void,
  LocalWebSocketConnectError | LocalWebSocketWriteError | RelayWebSocketWriteError,
  Scope.Scope
> {
  const socket = yield* acquireLocalWebSocket({
    url: url.toString(),
    protocols: [],
    headers: headersRecord(frame.headers),
  });
  const first = yield* socket.receive;
  if (first._tag !== "Open") {
    if (first._tag === "Close") {
      yield* sendCloseFrame(frame, first.code, first.reason, sendRelayFrame);
    }
    return;
  }

  let browserClosed = false;
  let nextLocalSeq = 0;
  const receive = Effect.gen(function* () {
    while (true) {
      const event = yield* socket.receive;
      switch (event._tag) {
        case "Open":
          break;
        case "Message":
          yield* sendRelayFrame({
            protocolVersion: PROTOCOL_VERSION,
            type: "ws.data",
            frameId: `frm_${nanoid(12)}`,
            connId: frame.connId,
            browserOutTopic: frame.browserOutTopic,
            seq: nextLocalSeq,
            data: encodeBase64(event.data),
            binary: event.binary,
          });
          nextLocalSeq += 1;
          break;
        case "Close":
          if (!browserClosed) {
            yield* sendCloseFrame(frame, event.code, event.reason, sendRelayFrame);
          }
          return;
      }
    }
  });
  const send = Effect.gen(function* () {
    while (true) {
      const command = yield* Queue.take(commands);
      if (command._tag === "Close") {
        browserClosed = true;
        yield* socket.close(command.frame.code, command.frame.reason);
        return;
      }
      const bytes = decodeBase64(command.frame.data);
      yield* socket.send(command.frame.binary ? bytes : decodeUtf8(bytes), command.frame.binary);
    }
  });
  const failOnOverflow = Deferred.await(overflow).pipe(
    Effect.andThen(socket.close(1013, "WebSocket command queue overflow")),
    Effect.andThen(
      sendCloseFrame(
        frame,
        1013,
        "Tunnel closed because browser frames arrived faster than they could be forwarded.",
        sendRelayFrame,
      ),
    ),
  );

  yield* Effect.raceFirst(receive, Effect.raceFirst(send, failOnOverflow));
});

function offerLocalCommand(
  commands: Queue.Queue<LocalCommand>,
  overflow: Deferred.Deferred<void>,
  command: LocalCommand,
): Effect.Effect<void> {
  return Effect.sync(() => Queue.offerUnsafe(commands, command)).pipe(
    Effect.flatMap((offered) =>
      offered ? Effect.void : Deferred.succeed(overflow, undefined).pipe(Effect.asVoid),
    ),
  );
}

function sendLocalFailure(frame: WsOpen, sendRelayFrame: SendRelayFrame) {
  return sendCloseFrame(frame, 1011, "Tunnel could not reach the local app.", sendRelayFrame).pipe(
    Effect.catchTag("RelayWebSocketWriteError", () => Effect.void),
  );
}

function sendCloseFrame(
  frame: WsOpen,
  code: number,
  reason: string,
  sendRelayFrame: SendRelayFrame,
) {
  return sendRelayFrame({
    protocolVersion: PROTOCOL_VERSION,
    type: "ws.close",
    frameId: `frm_${nanoid(12)}`,
    connId: frame.connId,
    browserOutTopic: frame.browserOutTopic,
    code,
    reason,
  });
}

function headersRecord(headers: ReadonlyArray<HeaderPair>): Record<string, string> {
  return Object.fromEntries(
    headers.filter(([name]) => name.toLowerCase() !== "sec-websocket-protocol"),
  );
}
