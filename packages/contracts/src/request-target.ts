import { Result, Schema } from "effect";

/** Expected failure for request targets that cannot be forwarded safely. */
export class TunnelRequestTargetError extends Schema.TaggedErrorClass<TunnelRequestTargetError>()(
  "TunnelRequestTargetError",
  {
    input: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

/** Origin-form request target split into URL pathname and search pieces. */
export type TunnelRequestTarget = {
  readonly path: string;
  readonly pathname: string;
  readonly search: string;
};

/** Parse a public request target without letting scheme-relative paths change origin. */
export function parseTunnelRequestTarget(
  input: string | undefined,
): Result.Result<TunnelRequestTarget, TunnelRequestTargetError> {
  const value = input ?? "/";

  if (!value.startsWith("/")) {
    return Result.fail(
      new TunnelRequestTargetError({
        input,
        message: "Tunnel request target must be an origin-form path starting with /.",
      }),
    );
  }

  const queryStart = value.indexOf("?");
  const pathname = queryStart === -1 ? value : value.slice(0, queryStart);
  const search = queryStart === -1 ? "" : value.slice(queryStart);

  return Result.succeed({ path: `${pathname}${search}`, pathname, search });
}

/** Construct a local app URL while pinning the configured local origin. */
export function localUrlFromTunnelRequestTarget(input: {
  readonly protocol: "http" | "ws";
  readonly host: string;
  readonly port: number;
  readonly requestTarget: TunnelRequestTarget;
}): URL {
  const url = new URL(`${input.protocol}://${input.host}:${input.port}/`);
  url.pathname = input.requestTarget.pathname;
  url.search = input.requestTarget.search;
  return url;
}
