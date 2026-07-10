/** Result of extracting a tunnel slug from a gateway host. */
export type ExtractSlugResult =
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly reason: "missing-host" | "wrong-domain" | "invalid-slug" };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_TOKEN = "{slug}";

/** Extract the tunnel slug from a request host using a domain or slug pattern. */
export function extractSlugFromHost(
  hostHeader: string | undefined,
  baseDomain: string,
): ExtractSlugResult {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return { _tag: "err", reason: "missing-host" };
  }

  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
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
