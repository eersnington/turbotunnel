import { Effect, Result, Schema } from "effect";

/** Expected failure for request targets that cannot be forwarded safely. */
export class TunnelRequestTargetError extends Schema.TaggedErrorClass<TunnelRequestTargetError>()(
  "TunnelRequestTargetError",
  {
    input: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

/** Expected failure when a configured local origin cannot form a URL. */
export class LocalUrlConstructionError extends Schema.TaggedErrorClass<LocalUrlConstructionError>()(
  "LocalUrlConstructionError",
  {
    protocol: Schema.Literals(["http", "ws"]),
    host: Schema.String,
    port: Schema.Number,
    message: Schema.String,
    cause: Schema.Defect(),
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

/** Effect-first request-target parser for composition with forwarding workflows. */
export function decodeTunnelRequestTarget(
  input: string | undefined,
): Effect.Effect<TunnelRequestTarget, TunnelRequestTargetError> {
  return Effect.fromResult(parseTunnelRequestTarget(input));
}

export type LocalUrlInput = {
  readonly protocol: "http" | "ws";
  readonly host: string;
  readonly port: number;
  readonly requestTarget: TunnelRequestTarget;
};

/** Construct a pinned local URL with invalid configured origins in the error channel. */
export function makeLocalUrlFromTunnelRequestTarget(
  input: LocalUrlInput,
): Effect.Effect<URL, LocalUrlConstructionError> {
  return Effect.try({
    try: () => constructLocalUrl(input),
    catch: (cause) =>
      new LocalUrlConstructionError({
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        message: `Local ${input.protocol} URL could not be constructed for ${input.host}:${input.port}; the local app was not contacted. Check the configured host and port.`,
        cause,
      }),
  });
}

/** Construct a local app URL while pinning the configured local origin. */
export function localUrlFromTunnelRequestTarget(input: {
  readonly protocol: "http" | "ws";
  readonly host: string;
  readonly port: number;
  readonly requestTarget: TunnelRequestTarget;
}): URL {
  return constructLocalUrl(input);
}

function constructLocalUrl(input: LocalUrlInput): URL {
  const url = new URL(`${input.protocol}://${input.host}:${input.port}/`);
  url.pathname = input.requestTarget.pathname;
  url.search = input.requestTarget.search;
  return url;
}
