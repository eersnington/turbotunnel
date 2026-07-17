/** Result of extracting a tunnel slug from a gateway host. */
export type ExtractSlugResult =
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly reason: "missing-host" | "wrong-domain" | "invalid-slug" };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_TOKEN = "{slug}";

/** Normalize an HTTP Host value for exact registration lookup. */
export function normalizeHost(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1 || (value.length > end + 1 && !/^:\d+$/.test(value.slice(end + 1)))) {
      return undefined;
    }
    return value.slice(1, end);
  }
  const withoutPort = value.replace(/:\d+$/, "").replace(/\.$/, "");
  if (withoutPort.length === 0 || withoutPort.includes(":")) return undefined;
  if (!URL.canParse(`http://${withoutPort}`)) return undefined;
  const parsed = new URL(`http://${withoutPort}`);
  return parsed.hostname === withoutPort ? parsed.hostname : undefined;
}

/** Extract the tunnel slug from a request host using a domain or slug pattern. */
export function extractSlugFromHost(
  hostHeader: string | undefined,
  baseDomain: string,
): ExtractSlugResult {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return { _tag: "err", reason: "missing-host" };
  }

  const host = normalizeHost(hostHeader);
  if (host === undefined) return { _tag: "err", reason: "missing-host" };
  const baseHost = baseDomain.trim().toLowerCase().replace(/:\d+$/, "");

  if (baseHost.includes(SLUG_TOKEN)) {
    return extractSlugFromPattern(host, baseHost);
  }

  const suffix = `.${baseHost}`;

  if (!host.endsWith(suffix)) {
    return { _tag: "err", reason: "wrong-domain" };
  }

  const slug = host.slice(0, -suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", reason: "invalid-slug" };
  }

  return { _tag: "ok", value: slug };
}

/** Return whether a request host addresses the gateway root rather than a tunnel. */
export function isGatewayRootHost(hostHeader: string | undefined, baseDomain: string): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return true;
  }

  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  const baseHost = baseDomain.trim().toLowerCase().replace(/:\d+$/, "");
  return !baseHost.includes(SLUG_TOKEN) && host === baseHost;
}

function extractSlugFromPattern(host: string, pattern: string): ExtractSlugResult {
  const tokenIndex = pattern.indexOf(SLUG_TOKEN);
  const prefix = pattern.slice(0, tokenIndex);
  const suffix = pattern.slice(tokenIndex + SLUG_TOKEN.length);

  if (!host.startsWith(prefix) || !host.endsWith(suffix)) {
    return { _tag: "err", reason: "wrong-domain" };
  }

  const slug = host.slice(prefix.length, host.length - suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", reason: "invalid-slug" };
  }

  return { _tag: "ok", value: slug };
}
