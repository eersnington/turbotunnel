#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/protocol";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { deployCommand, httpCommand } from "./commands/http.js";
import { isCliError, renderCliError, renderUnknownCliFailure } from "./errors.js";

const turbotunnel = Command.make("turbotunnel").pipe(
  Command.withDescription(
    "Expose a localhost HTTP/WebSocket app through a user-owned Vercel gateway",
  ),
  Command.withSubcommands([httpCommand, deployCommand]),
);

turbotunnel.pipe(
  Command.run({ version: TURBOTUNNEL_VERSION }),
  Effect.catch((cause) =>
    Effect.sync(() => {
      process.exitCode = 1;
    }).pipe(
      Effect.andThen(
        Console.error(isCliError(cause) ? renderCliError(cause) : renderUnknownCliFailure(cause)),
      ),
    ),
  ),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
