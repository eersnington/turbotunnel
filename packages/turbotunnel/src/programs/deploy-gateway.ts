import { Effect, Schema } from "effect";
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
import { type DeployGatewayError, VercelCliFailed } from "../errors.js";

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
  const existingProject =
    savedConfig.project !== plan.project
      ? undefined
      : yield* vercel
          .apiGet(`/v9/projects/${encodeURIComponent(plan.project)}`)
          .pipe(Effect.andThen(decodeProjectReference));
  const scope = existingProject?.accountId ?? savedConfig.teamId;

  if (input.output._tag === "Terminal") {
    yield* surface.append(renderDeployTerminal({ _tag: "Preview", plan, account }, colors));
  }

  const progress = (phase: DeployPhase) =>
    writeDeployProgress(input.output, output, surface, colors, { _tag: "Progress", phase });

  yield* progress("GeneratingWorkspace");
  yield* gatewayWorkspace.copyTo(plan.deployDir);
  yield* progress("LinkingProject");
  yield* vercel.linkProject(plan.deployDir, plan.project, scope);
  yield* progress("SettingEnvironment");
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_BASE_DOMAIN", plan.baseDomain, scope);
  yield* vercel.setProductionEnv(
    plan.deployDir,
    "TURBOTUNNEL_RELAY_SECRET",
    plan.relaySecret,
    scope,
  );
  yield* vercel.setProductionEnv(
    plan.deployDir,
    "TURBOTUNNEL_QUEUE_REGION",
    plan.queueRegion,
    scope,
  );

  if (!plan.publicHost.endsWith(".vercel.app")) {
    yield* progress("AddingDomain");
    yield* vercel.addDomain(plan.deployDir, domainToAdd(plan.baseDomain, plan.slug), plan.project);
  }

  yield* progress("DeployingProduction");
  const deploymentUrl = yield* vercel.deployProduction(plan.deployDir, scope);
  yield* progress("VerifyingGateway");
  yield* gatewayVerifier.verify(plan);
  yield* localConfigStore.update({
    ...toSavedDeployConfig(plan),
    ...(existingProject === undefined
      ? {}
      : { teamId: existingProject.accountId, projectId: existingProject.id }),
    ...(savedConfig.project === plan.project
      ? {}
      : { teamId: undefined, projectId: undefined, domainAssignments: undefined }),
  });
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

const ProjectReference = Schema.Struct({ id: Schema.String, accountId: Schema.String });
const decodeProjectReference = (input: unknown) =>
  Schema.decodeUnknownEffect(ProjectReference)(input).pipe(
    Effect.mapError(
      () =>
        new VercelCliFailed({
          command: "vercel api /v9/projects",
          failure: { _tag: "InvalidJsonOutput", stdout: "" },
          message:
            "Vercel returned project metadata without an id and accountId. Upgrade the Vercel CLI, then retry `tt deploy`. Your local tunnel config was not changed.",
        }),
    ),
  );

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
