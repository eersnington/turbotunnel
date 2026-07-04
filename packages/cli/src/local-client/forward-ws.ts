import { Buffer } from "node:buffer";

import {
  type HeaderPair,
  PROTOCOL_VERSION,
  type WsClose,
  type WsData,
  type WsOpen,
} from "@turbotunnel/protocol";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";

import type { LocalTarget } from "../config.js";

type SendRelayFrame = (frame: WsData | WsClose) => void;

export type LocalWebSocketHandle = {
  readonly sendData: (frame: WsData) => void;
  readonly close: (frame: WsClose) => void;
  readonly dispose: () => void;
};

/** Open and bind a local WebSocket for one public WebSocket connection. */
export function openLocalWebSocket(
  frame: WsOpen,
  target: LocalTarget,
  sendRelayFrame: SendRelayFrame,
): LocalWebSocketHandle {
  const url = new URL(frame.path, `ws://${target.host}:${target.port}`);
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

  socket.on("message", (data, isBinary) => {
    sendRelayFrame({
      protocolVersion: PROTOCOL_VERSION,
      type: "ws.data",
      frameId: `frm_${nanoid(12)}`,
      connId: frame.connId,
      browserOutTopic: frame.browserOutTopic,
      seq: nextLocalSeq,
      data: (Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data)
      ).toString("base64"),
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
      reason: `local websocket connection failed at ws://${target.host}:${target.port}`,
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
    const lowerName = name.toLowerCase();
    if (lowerName === "sec-websocket-protocol") {
      continue;
    }

    output[name] = value;
  }

  return output;
}
