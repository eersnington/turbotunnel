import { Buffer } from "node:buffer";

export function decodeBase64(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

export function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function decodeUtf8(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

export function encodeUtf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
