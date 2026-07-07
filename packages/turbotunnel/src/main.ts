#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { TURBOTUNNEL_VERSION } from "@turbotunnel/protocol";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

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

const localConfigLayer = LocalConfigStore.layer(join(homedir(), ".turbotunnel", "config.json")).pipe(
  Layer.provide(NodeServices.layer),
);
const entropyLayer = Entropy.live.pipe(Layer.provide(NodeServices.layer));
const vercelCliLayer = VercelCli.live.pipe(Layer.provide(NodeServices.layer));
const gatewayWorkspaceLayer = GatewayWorkspace.live.pipe(Layer.provide(NodeServices.layer));
const tunnelRuntimeLayer = TunnelRuntime.live.pipe(Layer.provide(CliOutput.live));

const liveLayer = Layer.mergeAll(
  CliOutput.live,
  entropyLayer,
  localConfigLayer,
  vercelCliLayer,
  gatewayWorkspaceLayer,
  GatewayVerifier.live,
  LocalAppProbe.live,
  tunnelRuntimeLayer,
);

turbotunnelCommand.pipe(
  Command.run({ version: TURBOTUNNEL_VERSION }),
  Effect.catch((error) =>
    Effect.gen(function* () {
      if (error._tag === "ShowHelp") {
        yield* Effect.sync(() => {
          process.exitCode = error.errors.length === 0 ? 0 : 1;
        });
        return;
      }

      const output = yield* CliOutput;
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
      yield* output.write(renderFailure({
        _tag: "Expected",
        output: requestedDeployOutput(process.argv),
        error,
      }));
    }),
  ),
  Effect.catchDefect((defect) =>
    Effect.gen(function* () {
      const output = yield* CliOutput;
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
      void defect;
      yield* output.write(renderFailure({
        _tag: "Unexpected",
        output: requestedDeployOutput(process.argv),
      }));
    }),
  ),
  Effect.provide(liveLayer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
