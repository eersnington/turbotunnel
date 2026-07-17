import { addressInCidr, isSupportedCidr } from "../src/ip.js";
import { describe, expect, it } from "vitest";

describe("shared CIDR support", () => {
  it("supports native IPv4 and IPv6 while rejecting mapped IPv6 forms", () => {
    expect(addressInCidr("192.0.2.4", "192.0.2.0/24")).toBe(true);
    expect(addressInCidr("2001:db8::4", "2001:db8::/32")).toBe(true);
    expect(isSupportedCidr("::ffff:192.0.2.0/120")).toBe(false);
    expect(isSupportedCidr("::ffff:c000:200/120")).toBe(false);
  });
});
