import { Effect } from "effect";

import { CliConfigError } from "../errors.js";

/** Parse `TURBOTUNNEL_PORT` (or equivalent) into a valid TCP port. */
export function parseEnvironmentPort(
  value: string | undefined,
  impact: string,
): Effect.Effect<number | undefined, CliConfigError> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!/^\d+$/u.test(value)) {
    return Effect.fail(
      new CliConfigError({
        message: `TURBOTUNNEL_PORT must be an integer from 1 to 65535. ${impact}`,
      }),
    );
  }
  const port = Number(value);
  return port >= 1 && port <= 65_535
    ? Effect.succeed(port)
    : Effect.fail(
        new CliConfigError({
          message: `TURBOTUNNEL_PORT must be an integer from 1 to 65535. ${impact}`,
        }),
      );
}
