import { BlockList, isIP } from "node:net";

/** CIDR support shared by relay configuration and gateway admission. */
export function isSupportedCidr(cidr: string): boolean {
  return parseCidr(cidr) !== undefined;
}

/** Normalize a bare IP or CIDR to `address/prefix`, or `undefined` if invalid. */
export function normalizeCidr(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.includes("/")) {
    if (trimmed.includes("%")) return undefined;
    const version = isIP(trimmed);
    if (version === 0 || isIpv4MappedIpv6(trimmed)) return undefined;
    return `${trimmed}/${version === 4 ? 32 : 128}`;
  }
  const parsed = parseCidr(trimmed);
  return parsed === undefined ? undefined : `${parsed.address}/${parsed.prefix}`;
}

/** Match IPv4 or non-mapped IPv6 addresses against a validated CIDR. */
export function addressInCidr(address: string, cidr: string): boolean {
  if (address.includes("%")) return false;
  const version = isIP(address);
  if (version === 0 || isIpv4MappedIpv6(address)) return false;
  const parsed = parseCidr(cidr);
  if (parsed === undefined || parsed.version !== version) return false;
  const list = new BlockList();
  list.addSubnet(parsed.address, parsed.prefix, version === 4 ? "ipv4" : "ipv6");
  return list.check(address, version === 4 ? "ipv4" : "ipv6");
}

function parseCidr(
  cidr: string,
): { readonly address: string; readonly prefix: number; readonly version: 4 | 6 } | undefined {
  const separator = cidr.lastIndexOf("/");
  if (separator <= 0 || separator === cidr.length - 1) return undefined;
  const address = cidr.slice(0, separator);
  const prefixText = cidr.slice(separator + 1);
  if (!/^\d{1,3}$/u.test(prefixText) || address.includes("%")) return undefined;
  const version = isIP(address);
  if (version === 0 || isIpv4MappedIpv6(address)) return undefined;
  const prefix = Number(prefixText);
  const maximum = version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) return undefined;
  return { address, prefix, version: version as 4 | 6 };
}

function isIpv4MappedIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const lowered = address.toLowerCase();
  if (lowered.includes(".")) return true;
  // Canonical form is ::ffff:0:0/96; also reject expanded leading zeros variants.
  return /^:?:ffff:/u.test(lowered) || lowered.startsWith("0:0:0:0:0:ffff:");
}
