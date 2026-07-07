import { Redacted } from "effect";

import { CliConfigError } from "../errors.js";

export type DeployCommandInput = {
  readonly project?: string;
  readonly domain?: string;
  readonly region?: string;
  readonly output: DeployOutput;
};

export type DeployOutput =
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "Json" };

export type SavedDeployConfig = {
  readonly project?: string;
  readonly slug?: string;
  readonly relayDomain?: string;
  readonly relaySecret?: string;
  readonly queueRegion?: string;
};

export type DeployPlan = {
  readonly slug: string;
  readonly project: string;
  readonly baseDomain: string;
  readonly publicHost: string;
  readonly queueRegion: string;
  readonly relaySecret: Redacted.Redacted<string>;
  readonly deployDir: string;
  readonly configPath: string;
  readonly reusedSavedTarget: boolean;
};

export type DeployPaths = {
  readonly deployDir: string;
  readonly configPath: string;
};

export type DeployPlanResult =
  | { readonly _tag: "ok"; readonly plan: DeployPlan }
  | { readonly _tag: "err"; readonly error: CliConfigError };

export const PROJECT_SUFFIX = "-turbotunnel";
export const DEFAULT_BASE_DOMAIN = "{slug}-turbotunnel.vercel.app";
export const DEFAULT_QUEUE_REGION = "iad1";

export function makeDeployPlan(options: {
  readonly input: DeployCommandInput;
  readonly savedConfig: SavedDeployConfig;
  readonly generatedSlug: string;
  readonly generatedSecret: Redacted.Redacted<string>;
  readonly paths: DeployPaths;
}): DeployPlanResult {
  const slugResult = resolveDeploySlug(options.input, options.savedConfig, options.generatedSlug);
  if (slugResult._tag === "err") {
    return slugResult;
  }

  const slug = slugResult.slug;
  const baseDomain = options.input.domain ?? options.savedConfig.relayDomain ?? DEFAULT_BASE_DOMAIN;
  const project = options.input.project ?? options.savedConfig.project ?? `${slug}${PROJECT_SUFFIX}`;
  const queueRegion = options.input.region ?? options.savedConfig.queueRegion ?? DEFAULT_QUEUE_REGION;
  const savedTargetMatches =
    options.savedConfig.project === project &&
    options.savedConfig.slug === slug &&
    options.savedConfig.relayDomain === baseDomain;
  const reusedSavedTarget =
    options.input.project === undefined &&
    options.input.domain === undefined &&
    options.input.region === undefined &&
    options.savedConfig.project !== undefined &&
    options.savedConfig.slug !== undefined &&
    options.savedConfig.relayDomain !== undefined;

  return {
    _tag: "ok",
    plan: {
      slug,
      project,
      baseDomain,
      publicHost: deployPublicHost(baseDomain, slug),
      queueRegion,
      relaySecret:
        savedTargetMatches && options.savedConfig.relaySecret !== undefined
          ? Redacted.make(options.savedConfig.relaySecret, { label: "relay-secret" })
          : options.generatedSecret,
      deployDir: options.paths.deployDir,
      configPath: options.paths.configPath,
      reusedSavedTarget,
    },
  };
}

export function deployPublicHost(baseDomain: string, slug: string): string {
  if (baseDomain.includes("{slug}")) {
    return baseDomain.replaceAll("{slug}", slug);
  }

  return `${slug}.${baseDomain}`;
}

export function domainToAdd(baseDomain: string, slug: string): string {
  if (baseDomain.includes("{slug}")) {
    return baseDomain.replaceAll("{slug}", slug);
  }

  return `*.${baseDomain}`;
}

export function toSavedDeployConfig(plan: DeployPlan): Required<SavedDeployConfig> {
  return {
    project: plan.project,
    slug: plan.slug,
    relayDomain: plan.baseDomain,
    relaySecret: Redacted.value(plan.relaySecret),
    queueRegion: plan.queueRegion,
  };
}

function resolveDeploySlug(
  input: DeployCommandInput,
  savedConfig: SavedDeployConfig,
  generatedSlug: string,
):
  | { readonly _tag: "ok"; readonly slug: string }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (input.project !== undefined) {
    if (input.project.endsWith(PROJECT_SUFFIX)) {
      const slug = input.project.slice(0, -PROJECT_SUFFIX.length);
      if (slug.length > 0) {
        return { _tag: "ok", slug };
      }
    }

    if (input.domain !== undefined) {
      return { _tag: "ok", slug: savedConfig.slug ?? generatedSlug };
    }

    return {
      _tag: "err",
      error: new CliConfigError({
        message:
          "--project without --domain must use the <slug>-turbotunnel format. Pass --domain when the project name does not include the tunnel slug.",
      }),
    };
  }

  return { _tag: "ok", slug: savedConfig.slug ?? generatedSlug };
}
