import { addressInCidr, isSupportedCidr, normalizeCidr } from "../src/ip.js";
import { describe, expect, it } from "vitest";

describe("shared CIDR support", () => {
  it("supports native IPv4 and IPv6 while rejecting mapped IPv6 forms", () => {
    expect(addressInCidr("192.0.2.4", "192.0.2.0/24")).toBe(true);
    expect(addressInCidr("2001:db8::4", "2001:db8::/32")).toBe(true);
    expect(isSupportedCidr("::ffff:192.0.2.0/120")).toBe(false);
    expect(isSupportedCidr("::ffff:c000:200/120")).toBe(false);
    expect(addressInCidr("::ffff:192.0.2.4", "192.0.2.0/24")).toBe(false);
  });

  it("rejects non-decimal prefixes and leading-zero IPv4 octets", () => {
    expect(isSupportedCidr("10.0.0.0/0x18")).toBe(false);
    expect(isSupportedCidr("10.0.0.0/24.0")).toBe(false);
    expect(isSupportedCidr("10.0.0.0/1e1")).toBe(false);
    expect(isSupportedCidr("10.0.0.0/+24")).toBe(false);
    expect(isSupportedCidr("192.168.001.001/32")).toBe(false);
    expect(addressInCidr("192.168.001.001", "192.168.0.0/16")).toBe(false);
  });

  it("rejects family mismatches and invalid shapes", () => {
    expect(addressInCidr("192.0.2.4", "2001:db8::/32")).toBe(false);
    expect(addressInCidr("2001:db8::1", "192.0.2.0/24")).toBe(false);
    expect(isSupportedCidr("not-an-ip/24")).toBe(false);
    expect(isSupportedCidr("192.0.2.0/33")).toBe(false);
    expect(isSupportedCidr("2001:db8::/129")).toBe(false);
    expect(isSupportedCidr("fe80::1%eth0/64")).toBe(false);
  });

  it("normalizes bare addresses to host prefixes", () => {
    expect(normalizeCidr("192.0.2.4")).toBe("192.0.2.4/32");
    expect(normalizeCidr("2001:db8::4")).toBe("2001:db8::4/128");
    expect(normalizeCidr(" 10.0.0.0/8 ")).toBe("10.0.0.0/8");
    expect(normalizeCidr("::ffff:192.0.2.4")).toBeUndefined();
    expect(normalizeCidr("192.168.001.001")).toBeUndefined();
  });
});
