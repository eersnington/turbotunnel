import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  decodeTunnelRequestTarget,
  LocalUrlConstructionError,
  localUrlFromTunnelRequestTarget,
  makeLocalUrlFromTunnelRequestTarget,
  parseTunnelRequestTarget,
  TunnelRequestTargetError,
} from "../src/index.js";

describe("tunnel request target", () => {
  it("defaults a missing target to root", () => {
    const parsed = parseTunnelRequestTarget(undefined);

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success).toEqual({ path: "/", pathname: "/", search: "" });
    }
  });

  it("parses an origin-form path and preserves query string", () => {
    const parsed = parseTunnelRequestTarget("/docs/search?q=tunnel&limit=10");

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success).toEqual({
        path: "/docs/search?q=tunnel&limit=10",
        pathname: "/docs/search",
        search: "?q=tunnel&limit=10",
      });
    }
  });

  it("rejects non-origin-form targets", () => {
    const parsed = parseTunnelRequestTarget("https://example.com/path");

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure).toBeInstanceOf(TunnelRequestTargetError);
      expect(parsed.failure.input).toBe("https://example.com/path");
    }
  });

  it("pins scheme-relative targets to the configured local origin", () => {
    const parsed = parseTunnelRequestTarget("//evil.test/path?q=1");

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      const url = localUrlFromTunnelRequestTarget({
        protocol: "http",
        host: "127.0.0.1",
        port: 3000,
        requestTarget: parsed.success,
      });

      expect(url.origin).toBe("http://127.0.0.1:3000");
      expect(url.pathname).toBe("//evil.test/path");
      expect(url.search).toBe("?q=1");
    }
  });

  it.effect("reports invalid local origins as typed construction failures", () =>
    Effect.gen(function* () {
      const requestTarget = yield* decodeTunnelRequestTarget("/health");
      const error = yield* makeLocalUrlFromTunnelRequestTarget({
        protocol: "http",
        host: "[invalid",
        port: 3000,
        requestTarget,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LocalUrlConstructionError);
      expect(error.host).toBe("[invalid");
      expect(error.port).toBe(3000);
    }),
  );
});
