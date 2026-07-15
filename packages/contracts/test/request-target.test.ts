import { Effect, Result } from "effect";
import { describe, expect, test } from "vitest";

import {
  decodeTunnelRequestTarget,
  LocalUrlConstructionError,
  localUrlFromTunnelRequestTarget,
  makeLocalUrlFromTunnelRequestTarget,
  parseTunnelRequestTarget,
  TunnelRequestTargetError,
} from "../src/index.js";

describe("tunnel request target", () => {
  test("defaults a missing target to root", () => {
    const parsed = parseTunnelRequestTarget(undefined);

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success).toEqual({ path: "/", pathname: "/", search: "" });
    }
  });

  test("parses an origin-form path and preserves query string", () => {
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

  test("rejects non-origin-form targets", () => {
    const parsed = parseTunnelRequestTarget("https://example.com/path");

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure.message).toBe(
        "Tunnel request target must be an origin-form path starting with /.",
      );
    }
  });

  test("pins scheme-relative targets to the configured local origin", () => {
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

  test("parses through the Effect seam and preserves typed failures", async () => {
    const target = await Effect.runPromise(decodeTunnelRequestTarget("/health?full=1"));
    const error = await Effect.runPromise(
      Effect.flip(decodeTunnelRequestTarget("https://example.com/path")),
    );

    expect(target).toEqual({
      path: "/health?full=1",
      pathname: "/health",
      search: "?full=1",
    });
    expect(error).toBeInstanceOf(TunnelRequestTargetError);
  });

  test("reports invalid local origins as typed construction failures", async () => {
    const requestTarget = await Effect.runPromise(decodeTunnelRequestTarget("/health"));
    const error = await Effect.runPromise(
      Effect.flip(
        makeLocalUrlFromTunnelRequestTarget({
          protocol: "http",
          host: "[invalid",
          port: 3000,
          requestTarget,
        }),
      ),
    );

    expect(error).toBeInstanceOf(LocalUrlConstructionError);
    expect(error.host).toBe("[invalid");
    expect(error.port).toBe(3000);
  });
});
