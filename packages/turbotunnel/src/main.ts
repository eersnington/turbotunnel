#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Layer } from "effect";
import { type CliError, Command } from "effect/unstable/cli";

import { AppPaths } from "./adapters/app-paths.js";
import { Entropy } from "./adapters/entropy.js";
import { GatewayVerifier } from "./adapters/gateway-verifier.js";
import { GatewayWorkspace } from "./adapters/gateway-workspace.js";
import { LocalAppProbe } from "./adapters/local-app-probe.js";
import { LocalConfigStore } from "./adapters/local-config-store.js";
import { TunnelRuntime } from "./adapters/tunnel-runtime.js";
import { VercelCli } from "./adapters/vercel-cli.js";
import { requestedDeployOutput, turbotunnelCommand } from "./cli/commands.js";
import { renderFailure } from "./cli/messages.js";
import { CliOutput } from "./cli/output.js";
import type { CliFailure } from "./errors.js";

const liveLayer = Layer.mergeAll(
  Entropy.live,
  LocalConfigStore.live,
  VercelCli.live,
  GatewayWorkspace.live,
  GatewayVerifier.live,
  LocalAppProbe.live,
  TunnelRuntime.live,
).pipe(
  Layer.provideMerge(AppPaths.live),
  Layer.provideMerge(CliOutput.live),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NodeServices.layer),
);

const handleShowHelp = Effect.fn("handleShowHelp")(function* (error: {
  readonly errors: ReadonlyArray<unknown>;
}) {
  yield* Effect.sync(() => {
    process.exitCode = error.errors.length === 0 ? 0 : 1;
  });
});

const handleExpectedFailure = Effect.fn("handleExpectedFailure")(function* (
  error: CliFailure | CliError.CliError,
) {
  const output = yield* CliOutput;
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
  yield* output.write(
    renderFailure({
      _tag: "Expected",
      output: requestedDeployOutput(process.argv),
      error,
    }),
  );
});

const handleUnexpectedFailure = Effect.fn("handleUnexpectedFailure")(function* (defect: unknown) {
  const output = yield* CliOutput;
  yield* Effect.logError("unexpected Turbotunnel defect", defect);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
  yield* output.write(
    renderFailure({
      _tag: "Unexpected",
      output: requestedDeployOutput(process.argv),
    }),
  );
});

turbotunnelCommand.pipe(
  Command.run({ version: TURBOTUNNEL_VERSION }),
  Effect.catchTag("ShowHelp", handleShowHelp),
  Effect.catchTags({
    UnrecognizedOption: handleExpectedFailure,
    DuplicateOption: handleExpectedFailure,
    MissingOption: handleExpectedFailure,
    MissingArgument: handleExpectedFailure,
    InvalidValue: handleExpectedFailure,
    UnknownSubcommand: handleExpectedFailure,
    UserError: handleExpectedFailure,
    CliConfigError: handleExpectedFailure,
    ConfigFileReadError: handleExpectedFailure,
    ConfigFileParseError: handleExpectedFailure,
    ConfigFileWriteError: handleExpectedFailure,
    VercelCliNotFound: handleExpectedFailure,
    VercelCliFailed: handleExpectedFailure,
    DeployOutputParseError: handleExpectedFailure,
    GatewayWorkspaceError: handleExpectedFailure,
    GatewayVerificationError: handleExpectedFailure,
    NoGatewayConfigured: handleExpectedFailure,
    LocalTargetNotReachable: handleExpectedFailure,
  }),
  Effect.catchDefect(handleUnexpectedFailure),
  Effect.provide(liveLayer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
