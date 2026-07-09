import { Buffer } from "node:buffer";

import {
  type HeaderPair,
  localUrlFromTunnelRequestTarget,
  parseTunnelRequestTarget,
  PROTOCOL_VERSION,
  type WsClose,
  type WsData,
  type WsOpen,
} from "@turbotunnel/contracts";
import { Result } from "effect";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";

import type { LocalTarget } from "../domain/tunnel-config.js";

type SendRelayFrame = (frame: WsData | WsClose) => void;

export type LocalWebSocketHandle = {
  readonly sendData: (frame: WsData) => void;
  readonly close: (frame: WsClose) => void;
  readonly dispose: () => void;
};

export function openLocalWebSocket(
  frame: WsOpen,
  target: LocalTarget,
  sendRelayFrame: SendRelayFrame,
): LocalWebSocketHandle | undefined {
  const requestTarget = parseTunnelRequestTarget(frame.path);
  if (Result.isFailure(requestTarget)) {
    sendRelayFrame({
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.close",
      frameId: `frm_${nanoid(12)}`,
      connId: frame.connId,
      browserOutTopic: frame.browserOutTopic,
      code: 1008,
      reason: requestTarget.failure.message,
    });

    return undefined;
  }

  const url = localUrlFromTunnelRequestTarget({
    protocol: "ws",
    host: target.host,
    port: target.port,
    requestTarget: requestTarget.success,
  });
  const queuedFrames: Array<WsData> = [];
  let nextLocalSeq = 0;
  let closeSent = false;
  const socket = new WebSocket(url, extractSubprotocols(frame.headers), {
    headers: headersRecord(frame.headers),
  });

  socket.on("open", () => {
    for (const queuedFrame of queuedFrames.splice(0)) {
      sendDataToLocalSocket(socket, queuedFrame);
    }
  });

  // `ws` emits complete messages as Buffer in its default nodebuffer mode.
  socket.on("message", (data: Buffer, isBinary) => {
    sendRelayFrame({
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.data",
      frameId: `frm_${nanoid(12)}`,
      connId: frame.connId,
      browserOutTopic: frame.browserOutTopic,
      seq: nextLocalSeq,
      data: data.toString("base64"),
      binary: isBinary,
    });
    nextLocalSeq += 1;
  });

  socket.on("close", (code, reason) => {
    if (closeSent) {
      return;
    }

    closeSent = true;
    sendRelayFrame({
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.close",
      frameId: `frm_${nanoid(12)}`,
      connId: frame.connId,
      browserOutTopic: frame.browserOutTopic,
      code,
      reason: reason.toString("utf8"),
    });
  });

  socket.on("error", () => {
    if (closeSent) {
      return;
    }

    closeSent = true;
    sendRelayFrame({
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.close",
      frameId: `frm_${nanoid(12)}`,
      connId: frame.connId,
      browserOutTopic: frame.browserOutTopic,
      code: 1011,
      reason: "Tunnel could not reach the local app.",
    });
  });

  return {
    sendData(dataFrame) {
      if (socket.readyState === WebSocket.OPEN) {
        sendDataToLocalSocket(socket, dataFrame);
        return;
      }

      if (socket.readyState === WebSocket.CONNECTING) {
        queuedFrames.push(dataFrame);
      }
    },
    close(closeFrame) {
      closeSent = true;
      socket.close(closeFrame.code, closeFrame.reason);
    },
    dispose() {
      closeSent = true;
      socket.close(1001, "relay connection closed");
    },
  };
}

function sendDataToLocalSocket(socket: WebSocket, frame: WsData): void {
  const data = Buffer.from(frame.data, "base64");
  socket.send(frame.binary ? data : data.toString("utf8"), { binary: frame.binary });
}

function extractSubprotocols(headers: ReadonlyArray<HeaderPair>): Array<string> {
  const protocols: Array<string> = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "sec-websocket-protocol") {
      continue;
    }

    for (const protocol of value.split(",")) {
      const trimmed = protocol.trim();
      if (trimmed.length > 0) {
        protocols.push(trimmed);
      }
    }
  }

  return protocols;
}

function headersRecord(headers: ReadonlyArray<HeaderPair>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "sec-websocket-protocol") {
      output[name] = value;
    }
  }

  return output;
}
