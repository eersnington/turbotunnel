import { Effect } from "effect";

import { AppPaths } from "../adapters/app-paths.js";
import { renderDeploy } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import { Entropy } from "../adapters/entropy.js";
import { GatewayVerifier } from "../adapters/gateway-verifier.js";
import { GatewayWorkspace } from "../adapters/gateway-workspace.js";
import { LocalConfigStore } from "../adapters/local-config-store.js";
import { VercelCli } from "../adapters/vercel-cli.js";
import {
  type DeployCommandInput,
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
  CliOutput | AppPaths | Entropy | LocalConfigStore | VercelCli | GatewayWorkspace | GatewayVerifier
> {
  const output = yield* CliOutput;
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
    yield* output.write(renderDeploy({ _tag: "Preview", plan, account }));
  }

  yield* output.write(renderDeploy({ _tag: "Progress", message: "Generating gateway files..." }));
  yield* gatewayWorkspace.copyTo(plan.deployDir);
  yield* output.write(renderDeploy({ _tag: "Progress", message: "Linking Vercel project..." }));
  yield* vercel.linkProject(plan.deployDir, plan.project);
  yield* output.write(
    renderDeploy({ _tag: "Progress", message: "Setting gateway Environment Variables..." }),
  );
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_BASE_DOMAIN", plan.baseDomain);
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_RELAY_SECRET", plan.relaySecret);
  yield* vercel.setProductionEnv(plan.deployDir, "TURBOTUNNEL_QUEUE_REGION", plan.queueRegion);

  if (!plan.publicHost.endsWith(".vercel.app")) {
    yield* output.write(renderDeploy({ _tag: "Progress", message: "Adding gateway domain..." }));
    yield* vercel.addDomain(plan.deployDir, domainToAdd(plan.baseDomain, plan.slug), plan.project);
  }

  yield* output.write(renderDeploy({ _tag: "Progress", message: "Deploying gateway..." }));
  const deploymentUrl = yield* vercel.deployProduction(plan.deployDir);
  yield* output.write(renderDeploy({ _tag: "Progress", message: "Verifying gateway..." }));
  yield* gatewayVerifier.verify(plan);
  yield* localConfigStore.write(toSavedDeployConfig(plan));
  yield* output.write(
    renderDeploy({
      _tag: "Summary",
      output: input.output,
      plan,
      deploymentUrl,
    }),
  );
});
