#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/protocol";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { deployCommand, httpCommand } from "./commands/http.js";
import { renderCliFailure } from "./errors.js";

const turbotunnel = Command.make("turbotunnel").pipe(
  Command.withDescription("Tunnel your local dev server with a public URL, powered by Vercel WebSockets."),
  Command.withSubcommands([httpCommand, deployCommand]),
);

turbotunnel.pipe(
  Command.run({ version: TURBOTUNNEL_VERSION }),
  Effect.catch((cause) =>
    Effect.sync(() => {
      process.exitCode = 1;
    }).pipe(Effect.andThen(Effect.sync(() => renderCliFailure(cause)))),
  ),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
