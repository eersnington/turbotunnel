import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/** Compares a bearer token without data-dependent byte comparison. */
export function hasValidBearerAuth(value: string | undefined, expectedSecret: string): boolean {
  if (value === undefined || !value.startsWith("Bearer ")) {
    return false;
  }
  const tokenBytes = Buffer.from(value.slice("Bearer ".length));
  const expectedBytes = Buffer.from(expectedSecret);
  return (
    tokenBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(tokenBytes, expectedBytes)
  );
}
