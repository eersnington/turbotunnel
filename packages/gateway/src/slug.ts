type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_TOKEN = "{slug}";

export class ExtractSlugError extends Error {
  readonly _tag = "ExtractSlugError" as const;

  constructor(readonly reason: "missing-host" | "wrong-domain" | "invalid-slug") {
    super(`Unable to extract tunnel slug from host: ${reason}`);
  }
}

/**
 * Extract the tunnel slug from Host.
 *
 * Supports both wildcard hosts (`{slug}.example.com`) and the default Vercel
 * project-host pattern (`{slug}-turbotunnel.vercel.app`), which avoids requiring
 * a custom domain for the MVP deploy flow.
 */
export function extractSlugFromHost(
  hostHeader: string | undefined,
  baseDomain: string,
): Result<string, ExtractSlugError> {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return { _tag: "err", error: new ExtractSlugError("missing-host") };
  }

  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  const baseHost = baseDomain.trim().toLowerCase().replace(/:\d+$/, "");

  if (baseHost.includes(SLUG_TOKEN)) {
    return extractSlugFromPattern(host, baseHost);
  }

  const suffix = `.${baseHost}`;

  if (!host.endsWith(suffix)) {
    return { _tag: "err", error: new ExtractSlugError("wrong-domain") };
  }

  const slug = host.slice(0, -suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", error: new ExtractSlugError("invalid-slug") };
  }

  return { _tag: "ok", value: slug };
}

function extractSlugFromPattern(host: string, pattern: string): Result<string, ExtractSlugError> {
  const tokenIndex = pattern.indexOf(SLUG_TOKEN);
  const prefix = pattern.slice(0, tokenIndex);
  const suffix = pattern.slice(tokenIndex + SLUG_TOKEN.length);

  if (!host.startsWith(prefix) || !host.endsWith(suffix)) {
    return { _tag: "err", error: new ExtractSlugError("wrong-domain") };
  }

  const slug = host.slice(prefix.length, host.length - suffix.length);
  if (!SLUG_PATTERN.test(slug) || slug.includes(".")) {
    return { _tag: "err", error: new ExtractSlugError("invalid-slug") };
  }

  return { _tag: "ok", value: slug };
}
