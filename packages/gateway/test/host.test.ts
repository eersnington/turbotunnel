import { describe, expect, test } from "vitest";

import { extractSlugFromHost, isGatewayRootHost } from "../src/host.js";

describe("extractSlugFromHost", () => {
  test("rejects a missing host", () => {
    expect(extractSlugFromHost(undefined, "tunnel.example.com")).toEqual({
      _tag: "err",
      reason: "missing-host",
    });
  });

  test("rejects the wrong domain", () => {
    expect(extractSlugFromHost("demo.other.example.com", "tunnel.example.com")).toEqual({
      _tag: "err",
      reason: "wrong-domain",
    });
  });

  test("rejects an invalid slug", () => {
    expect(extractSlugFromHost("bad_slug.tunnel.example.com", "tunnel.example.com")).toEqual({
      _tag: "err",
      reason: "invalid-slug",
    });
  });

  test("extracts a subdomain slug", () => {
    expect(extractSlugFromHost("demo.tunnel.example.com", "tunnel.example.com")).toEqual({
      _tag: "ok",
      value: "demo",
    });
  });

  test("strips ports from the host and base domain", () => {
    expect(extractSlugFromHost("demo.tunnel.example.com:443", "tunnel.example.com:8443")).toEqual({
      _tag: "ok",
      value: "demo",
    });
  });

  test("extracts a slug from a domain pattern", () => {
    expect(extractSlugFromHost("tunnel-demo.example.com", "tunnel-{slug}.example.com")).toEqual({
      _tag: "ok",
      value: "demo",
    });
  });

  test("rejects the wrong domain for a domain pattern", () => {
    expect(extractSlugFromHost("demo.example.com", "tunnel-{slug}.example.com")).toEqual({
      _tag: "err",
      reason: "wrong-domain",
    });
  });
});

describe("isGatewayRootHost", () => {
  test("accepts a missing or empty host", () => {
    expect(isGatewayRootHost(undefined, "tunnel.example.com")).toBe(true);
    expect(isGatewayRootHost("  ", "tunnel.example.com")).toBe(true);
  });

  test("accepts the exact base domain", () => {
    expect(isGatewayRootHost("tunnel.example.com", "tunnel.example.com")).toBe(true);
  });

  test("rejects a slug subdomain", () => {
    expect(isGatewayRootHost("demo.tunnel.example.com", "tunnel.example.com")).toBe(false);
  });

  test("rejects hosts when the base domain contains a slug pattern", () => {
    expect(isGatewayRootHost("tunnel-demo.example.com", "tunnel-{slug}.example.com")).toBe(false);
  });
});
