import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { Redacted } from "effect";
import { customAlphabet } from "nanoid";

import { CliConfigError } from "./errors.js";

export type DeployCommandOptions = {
  readonly project?: string;
  readonly domain?: string;
  readonly region?: string;
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

export type SavedDeployTarget = {
  readonly project?: string;
  readonly slug?: string;
  readonly relayDomain?: string;
  readonly relaySecret?: string;
  readonly queueRegion?: string;
};

export type DeployPlanResult =
  | { readonly _tag: "ok"; readonly value: DeployPlan }
  | { readonly _tag: "err"; readonly error: CliConfigError };

const cleanSlug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
export const PROJECT_SUFFIX = "-turbotunnel";
export const DEFAULT_BASE_DOMAIN = "{slug}-turbotunnel.vercel.app";
export const DEFAULT_QUEUE_REGION = "iad1";

export function makeDeployPlan(
  options: DeployCommandOptions,
  savedConfig: SavedDeployTarget,
): DeployPlanResult {
  const slugResult = resolveDeploySlug(options, savedConfig);
  if (slugResult._tag === "err") {
    return slugResult;
  }

  const slug = slugResult.value;
  const baseDomain = options.domain ?? savedConfig.relayDomain ?? DEFAULT_BASE_DOMAIN;
  const project = options.project ?? savedConfig.project ?? `${slug}${PROJECT_SUFFIX}`;
  const queueRegion = options.region ?? savedConfig.queueRegion ?? DEFAULT_QUEUE_REGION;
  const sameSavedTarget =
    savedConfig.project === project &&
    savedConfig.slug === slug &&
    savedConfig.relayDomain === baseDomain;
  const reusedSavedTarget =
    options.project === undefined &&
    options.domain === undefined &&
    options.region === undefined &&
    savedConfig.project !== undefined &&
    savedConfig.slug !== undefined &&
    savedConfig.relayDomain !== undefined;

  return {
    _tag: "ok",
    value: {
      slug,
      project,
      baseDomain,
      publicHost: deployPublicHost(baseDomain, slug),
      queueRegion,
      relaySecret: Redacted.make(
        sameSavedTarget && savedConfig.relaySecret !== undefined
          ? savedConfig.relaySecret
          : `ttsec_${randomBytes(24).toString("base64url")}`,
        { label: "relay-secret" },
      ),
      deployDir: join(homedir(), ".turbotunnel", "relay"),
      configPath: join(homedir(), ".turbotunnel", "config.json"),
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

function resolveDeploySlug(
  options: DeployCommandOptions,
  savedConfig: LocalConfig,
):
  | { readonly _tag: "ok"; readonly value: string }
  | { readonly _tag: "err"; readonly error: CliConfigError } {
  if (options.project !== undefined) {
    if (options.project.endsWith(PROJECT_SUFFIX)) {
      const slug = options.project.slice(0, -PROJECT_SUFFIX.length);
      if (slug.length > 0) {
        return { _tag: "ok", value: slug };
      }
    }

    if (options.domain !== undefined) {
      return { _tag: "ok", value: savedConfig.slug ?? `tt${cleanSlug()}` };
    }

    return {
      _tag: "err",
      error: new CliConfigError({
        message:
          "--project without --domain must use the <slug>-turbotunnel format. Pass --domain when the project name does not include the tunnel slug.",
      }),
    };
  }

  if (savedConfig.slug !== undefined) {
    return { _tag: "ok", value: savedConfig.slug };
  }

  return { _tag: "ok", value: `tt${cleanSlug()}` };
}
