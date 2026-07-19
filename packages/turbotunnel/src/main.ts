#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Effect, Layer } from "effect";
import { type CliError, Command } from "effect/unstable/cli";

import { AppPaths } from "./adapters/app-paths.js";
import { Entropy } from "./adapters/entropy.js";
import { GatewayVerifier } from "./adapters/gateway-verifier.js";
import { GatewayStatusChecker } from "./adapters/gateway-status-checker.js";
import { GatewayControlClient } from "./adapters/gateway-control-client.js";
import { GatewayWorkspace } from "./adapters/gateway-workspace.js";
import { LocalConfigStore } from "./adapters/local-config-store.js";
import { LocalControl } from "./adapters/local-control.js";
import { RuntimeRegistry } from "./adapters/runtime-registry.js";
import { TunnelRuntime } from "./adapters/tunnel-runtime.js";
import { DevProcess } from "./adapters/dev-process.js";
import { ProjectConfigStore } from "./adapters/project-config-store.js";
import { ProjectDomain } from "./adapters/project-domain.js";
import { VercelCli } from "./adapters/vercel-cli.js";
import { requestedOutput, turbotunnelCommand } from "./cli/commands.js";
import { prepareCliArgv } from "./cli/argv.js";
import { renderFailure } from "./cli/messages.js";
import { CliOutput } from "./cli/output.js";
import { tunnelReporterLive } from "./cli/lifecycle-presenter.js";
import { TerminalSurface } from "./cli/terminal-surface.js";
import type { CliFailure } from "./errors.js";
import { TunnelReporter } from "./runtime/tunnel-reporter.js";

const platformLayer = Layer.mergeAll(
  AppPaths.live,
  CliOutput.live,
  NodeHttpClient.layerFetch,
  NodeServices.layer,
);
const configurationLayer = Layer.mergeAll(LocalConfigStore.live, VercelCli.live);
const localRuntimeLayer = Layer.mergeAll(RuntimeRegistry.live, LocalControl.live);
const reporterLayer = tunnelReporterLive.pipe(Layer.provide(TerminalSurface.live));
const terminalUiLayer = Layer.merge(TerminalSurface.live, reporterLayer);
const tunnelRuntimeLayer = TunnelRuntime.live.pipe(
  Layer.provide(Layer.merge(localRuntimeLayer, terminalUiLayer)),
);
const gatewayControlLayer = GatewayControlClient.live.pipe(Layer.provide(configurationLayer));
const projectDomainLayer = ProjectDomain.live.pipe(Layer.provide(configurationLayer));

const applicationLayer = Layer.mergeAll(
  Entropy.live,
  configurationLayer,
  GatewayWorkspace.live,
  GatewayVerifier.live,
  GatewayStatusChecker.live,
  gatewayControlLayer,
  DevProcess.live,
  ProjectConfigStore.live,
  projectDomainLayer,
  terminalUiLayer,
  localRuntimeLayer,
  tunnelRuntimeLayer,
).pipe(Layer.provide(platformLayer));
const liveLayer = Layer.merge(platformLayer, applicationLayer);

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
  const reporter = yield* TunnelReporter;
  yield* reporter.emit({ _tag: "UnrecoverableFailure" });
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
  yield* output.write(
    renderFailure({
      _tag: "Expected",
      output: requestedOutput(process.argv),
      error,
    }),
  );
});

const handleUnexpectedFailure = Effect.fn("handleUnexpectedFailure")(function* (defect: unknown) {
  const output = yield* CliOutput;
  const reporter = yield* TunnelReporter;
  yield* reporter.emit({ _tag: "UnrecoverableFailure" });
  yield* Effect.logError("unexpected Turbotunnel defect", defect);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
  yield* output.write(
    renderFailure({
      _tag: "Unexpected",
      output: requestedOutput(process.argv),
    }),
  );
});

Command.runWith(turbotunnelCommand, { version: TURBOTUNNEL_VERSION })(
  prepareCliArgv(process.argv.slice(2)),
).pipe(
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
    GatewayControlError: handleExpectedFailure,
    NoGatewayConfigured: handleExpectedFailure,
    RuntimeRegistryError: handleExpectedFailure,
    LocalControlError: handleExpectedFailure,
    DevProcessError: handleExpectedFailure,
  }),
  Effect.catchDefect(handleUnexpectedFailure),
  Effect.provide(liveLayer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
