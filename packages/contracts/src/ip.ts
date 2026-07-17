/** CIDR support shared by relay configuration and gateway admission. */
export function isSupportedCidr(cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator <= 0) return false;
  const network = parseIpAddress(cidr.slice(0, separator));
  const prefix = Number(cidr.slice(separator + 1));
  return network !== undefined && Number.isInteger(prefix) && prefix >= 0 && prefix <= network.bits;
}

/** Match IPv4 or non-mapped IPv6 addresses against a validated CIDR. */
export function addressInCidr(address: string, cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator <= 0) return false;
  const addressValue = parseIpAddress(address);
  const network = parseIpAddress(cidr.slice(0, separator));
  const prefix = Number(cidr.slice(separator + 1));
  if (
    addressValue === undefined ||
    network === undefined ||
    addressValue.bits !== network.bits ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > network.bits
  )
    return false;
  const shift = BigInt(network.bits - prefix);
  return addressValue.value >> shift === network.value >> shift;
}

function parseIpAddress(
  address: string,
): { readonly bits: 32 | 128; readonly value: bigint } | undefined {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split(".").map(Number);
    if (parts.some((part) => part > 255)) return undefined;
    return { bits: 32, value: parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n) };
  }
  if (!address.includes(":") || address.includes(".") || address.includes(":::")) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  let value = 0n;
  for (const group of [...left, ...Array.from({ length: missing }, () => "0"), ...right]) {
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  if (value >> 32n === 0xffffn) return undefined;
  return { bits: 128, value };
}
