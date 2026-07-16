import { Effect } from "effect";
import pc from "picocolors";

import { AppPaths } from "../adapters/app-paths.js";
import {
  renderDeploy,
  renderDeployTerminal,
  type DeployMessage,
  type DeployPhase,
} from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import { TerminalSurface } from "../cli/terminal-surface.js";
import { Entropy } from "../adapters/entropy.js";
import { GatewayVerifier } from "../adapters/gateway-verifier.js";
import { GatewayWorkspace } from "../adapters/gateway-workspace.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { VercelCli } from "../adapters/vercel-cli.js";
import {
  type DeployCommandInput,
  type DeployOutput,
  domainToAdd,
  makeDeployPlan,
  toSavedDeployConfig,
} from "../domain/deploy-plan.js";
import type { DeployGatewayError } from "../errors.js";

export const deployGateway = Effect.fn("deployGateway")(function* (
  input: DeployCommandInput,
): Effect.fn.Return<
  void,
  DeployGatewayError,
  | CliOutput
  | TerminalSurface
  | AppPaths
  | Entropy
  | LocalConfigStore
  | VercelCli
  | GatewayWorkspace
  | GatewayVerifier
> {
  const output = yield* CliOutput;
  const surface = yield* TerminalSurface;
  const colors = pc.createColors(surface.capabilities.color);
  const paths = yield* AppPaths;
  const entropy = yield* Entropy;
  const localConfigStore = yield* LocalConfigStore;
  const vercel = yield* VercelCli;
  const gatewayWorkspace = yield* GatewayWorkspace;
  const gatewayVerifier = yield* GatewayVerifier;
  const savedConfig = yield* localConfigStore.read;
  const plan = yield* makeDeployPlan({
    input,
    savedConfig,
    generatedSlug: yield* entropy.deploySlug,
    generatedSecret: yield* entropy.relaySecret,
    paths,
  });
  yield* vercel.requireInstalled;
  const account = yield* vercel.currentAccount;

  if (input.output._tag === "Terminal") {
    yield* surface.append(renderDeployTerminal({ _tag: "Preview", plan, account }, colors));
  }

  const progress = (phase: DeployPhase) =>
    writeDeployProgress(input.output, output, surface, colors, { _tag: "Progress", phase });

  yield* progress("GeneratingWorkspace");
  yield* gatewayWorkspace.copyTo(plan.deployDir);
  yield* progress("LinkingProject");
  yield* vercel.linkProject(plan.deployDir, plan.project);
  yield* progress("SettingEnvironment");
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_BASE_DOMAIN", plan.baseDomain);
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_RELAY_SECRET", plan.relaySecret);
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_QUEUE_REGION", plan.queueRegion);

  if (!plan.publicHost.endsWith(".vercel.app")) {
    yield* progress("AddingDomain");
    yield* vercel.addDomain(plan.deployDir, domainToAdd(plan.baseDomain, plan.slug), plan.project);
  }

  yield* progress("DeployingProduction");
  const deploymentUrl = yield* vercel.deployProduction(plan.deployDir);
  yield* progress("VerifyingGateway");
  yield* gatewayVerifier.verify(plan);
  yield* localConfigStore.write(toSavedDeployConfig(plan));
  const summary: DeployMessage = {
    _tag: "Summary",
    output: input.output,
    plan,
    deploymentUrl,
  };
  yield* input.output._tag === "Terminal"
    ? surface.settle(renderDeployTerminal(summary, colors))
    : output.write(renderDeploy(summary));
});

function writeDeployProgress(
  mode: DeployOutput,
  output: CliOutput["Service"],
  surface: TerminalSurface["Service"],
  colors: ReturnType<typeof pc.createColors>,
  message: Extract<DeployMessage, { readonly _tag: "Progress" }>,
): Effect.Effect<void> {
  return mode._tag === "Terminal"
    ? surface.progress(renderDeployTerminal(message, colors))
    : output.write(renderDeploy(message));
}
