import { Context, Effect, Layer, Schema } from "effect";

import {
  CliConfigError,
  ConfigFileParseError,
  ConfigFileReadError,
  ConfigFileWriteError,
  VercelCliFailed,
  type VercelCliNotFound,
} from "../errors.js";
import {
  LocalConfigStore,
  type LocalConfig,
  type ProjectDomainAssignment,
} from "./local-config-store.js";
import { VercelCli } from "./vercel-cli.js";

export type GatewayProjectIdentity = {
  readonly project?: string;
  readonly teamId?: string;
  readonly projectId?: string;
};

export type ProjectDomainInput = {
  readonly configIdentity: string;
  readonly targetName?: string;
  readonly targetPath: string;
  readonly requestedSlug?: string;
  readonly requestedDomain?: string;
  readonly gateway: GatewayProjectIdentity;
  readonly generatedDeploySlug: string;
};

export type ProjectDomainResult = {
  readonly slug: string;
  readonly domain: string;
};

export type ProjectDomainError =
  | CliConfigError
  | ConfigFileReadError
  | ConfigFileParseError
  | ConfigFileWriteError
  | VercelCliNotFound
  | VercelCliFailed;

export type ProjectDomainShape = {
  readonly reconcile: (
    input: ProjectDomainInput,
  ) => Effect.Effect<ProjectDomainResult, ProjectDomainError>;
};

export class ProjectDomain extends Context.Service<ProjectDomain, ProjectDomainShape>()(
  "turbotunnel/effect/ProjectDomain",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const configStore = yield* LocalConfigStore;
      const vercel = yield* VercelCli;
      return ProjectDomain.of({
        reconcile: Effect.fn("ProjectDomain.reconcile")(function* (input) {
          yield* validateInput(input);
          const saved = yield* configStore.read;
          const previous = saved.domainAssignments?.find((assignment) =>
            assignmentMatches(assignment, input),
          );
          const projectName = input.gateway.project ?? saved.project;
          if (projectName === undefined) {
            return yield* new CliConfigError({
              message:
                "No Vercel gateway project is saved. Run `tt deploy` before assigning a project domain. No Vercel project or tunnel was changed.",
            });
          }

          const teamId = input.gateway.teamId ?? saved.teamId;
          const projectRef = input.gateway.projectId ?? saved.projectId ?? projectName;
          const projectJson = yield* vercel.apiGet(projectPath(projectRef, teamId));
          const project = yield* decodeProject(projectJson).pipe(
            Effect.mapError((error) => apiShapeError(error, "gateway project")),
          );
          const stableTeamId = teamId ?? project.accountId;
          const domainsJson = yield* vercel.apiGet(projectDomainsPath(project.id, stableTeamId));
          const domains = yield* decodeProjectDomains(domainsJson).pipe(
            Effect.mapError((error) => apiShapeError(error, "gateway project domains")),
          );
          const attached = new Set(domains.domains.map(({ name }) => name.toLowerCase()));
          const preferred = preferredAssignment(input);

          if (
            previous !== undefined &&
            assignmentSatisfiesRequest(previous, input, preferred) &&
            attached.has(previous.domain.toLowerCase())
          ) {
            if (input.requestedDomain !== undefined) {
              yield* vercel.verifyDomain(
                input.targetPath,
                previous.domain,
                project.id,
                stableTeamId,
              );
            }
            yield* saveAssignment(configStore, saved, project, stableTeamId, previous);
            return { slug: previous.slug, domain: previous.domain };
          }

          const assignment = attached.has(preferred.domain)
            ? preferred
            : yield* addPreferredOrFallback(vercel, input, project.id, stableTeamId, preferred);
          if (input.requestedDomain !== undefined) {
            yield* vercel.verifyDomain(
              input.targetPath,
              assignment.domain,
              project.id,
              stableTeamId,
            );
          }
          yield* saveAssignment(
            configStore,
            saved,
            project,
            stableTeamId,
            assignmentRecord(input, assignment),
          );
          return assignment;
        }),
      });
    }),
  );
}

export const reconcileProjectDomain = Effect.fn("reconcileProjectDomain")(function* (
  input: ProjectDomainInput,
) {
  return yield* (yield* ProjectDomain).reconcile(input);
});

const VercelProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  accountId: Schema.optional(Schema.String),
});
const VercelProjectDomains = Schema.Struct({
  domains: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const decodeProject = Schema.decodeUnknownEffect(VercelProject);
const decodeProjectDomains = Schema.decodeUnknownEffect(VercelProjectDomains);
// Leave room for the `ttxxxxxx-` prefix used by the conflict fallback.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,53}$/u;
const GENERATED_SLUG_PATTERN = /^tt[a-z0-9]{6}$/u;

function validateInput(input: ProjectDomainInput): Effect.Effect<void, CliConfigError> {
  if (input.requestedSlug !== undefined && input.requestedDomain !== undefined) {
    return Effect.fail(
      new CliConfigError({
        message:
          "A project target cannot request both a slug and a custom domain. Choose one and retry. No Vercel project or tunnel was changed.",
      }),
    );
  }
  if (input.requestedSlug !== undefined && !SLUG_PATTERN.test(input.requestedSlug)) {
    return Effect.fail(
      new CliConfigError({
        message:
          "Project domain slug must be at most 54 characters, contain only lowercase letters, digits, and hyphens, and start with a letter or digit.",
      }),
    );
  }
  if (!GENERATED_SLUG_PATTERN.test(input.generatedDeploySlug)) {
    return Effect.fail(
      new CliConfigError({
        message:
          "Generated deploy slug must use the tt prefix followed by six lowercase letters or digits. No Vercel project or tunnel was changed.",
      }),
    );
  }
  if (input.requestedDomain !== undefined && !validDomain(input.requestedDomain)) {
    return Effect.fail(
      new CliConfigError({
        message:
          "Custom project domain must be an exact lowercase hostname without a scheme, port, path, or wildcard.",
      }),
    );
  }
  return Effect.void;
}

function preferredAssignment(input: ProjectDomainInput): ProjectDomainResult {
  if (input.requestedDomain !== undefined) {
    return { slug: input.generatedDeploySlug, domain: input.requestedDomain };
  }
  if (input.requestedSlug !== undefined) {
    if (`${input.requestedSlug}-turbotunnel`.length > 63) {
      const slug = `${input.generatedDeploySlug}-${input.requestedSlug}`;
      return { slug, domain: `${slug}.vercel.app` };
    }
    return { slug: input.requestedSlug, domain: `${input.requestedSlug}-turbotunnel.vercel.app` };
  }
  return {
    slug: input.generatedDeploySlug,
    domain: `${input.generatedDeploySlug}-turbotunnel.vercel.app`,
  };
}

const addPreferredOrFallback = Effect.fn("ProjectDomain.addPreferredOrFallback")(function* (
  vercel: VercelCli["Service"],
  input: ProjectDomainInput,
  project: string,
  scope: string | undefined,
  preferred: ProjectDomainResult,
) {
  const error = yield* vercel
    .addDomain(input.targetPath, preferred.domain, project, scope)
    .pipe(Effect.as(undefined), Effect.catchTag("VercelCliFailed", Effect.succeed));
  if (error === undefined) return preferred;
  if (input.requestedSlug === undefined || !domainNameConflict(error)) return yield* error;

  const slug = `${input.generatedDeploySlug}-${input.requestedSlug}`;
  const fallback = { slug, domain: `${slug}.vercel.app` };
  if (preferred.domain === fallback.domain) return yield* error;
  yield* vercel.addDomain(input.targetPath, fallback.domain, project, scope);
  return fallback;
});

function domainNameConflict(error: VercelCliFailed): boolean {
  return /conflict|already (?:assigned|in use)|not available/iu.test(error.message);
}

function assignmentMatches(
  assignment: ProjectDomainAssignment,
  input: ProjectDomainInput,
): boolean {
  return (
    assignment.configIdentity === input.configIdentity &&
    assignment.targetName === input.targetName &&
    assignment.targetPath === input.targetPath
  );
}

function assignmentSatisfiesRequest(
  assignment: ProjectDomainAssignment,
  input: ProjectDomainInput,
  preferred: ProjectDomainResult,
): boolean {
  if (input.requestedDomain !== undefined) return assignment.domain === input.requestedDomain;
  if (input.requestedSlug === undefined) return true;
  if (assignment.domain === preferred.domain && assignment.slug === preferred.slug) return true;
  const escaped = input.requestedSlug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`^tt[a-z0-9]{6}-${escaped}$`, "u").test(assignment.slug) &&
    assignment.domain === `${assignment.slug}.vercel.app`
  );
}

function assignmentRecord(
  input: ProjectDomainInput,
  result: ProjectDomainResult,
): ProjectDomainAssignment {
  return {
    configIdentity: input.configIdentity,
    targetName: input.targetName,
    targetPath: input.targetPath,
    domain: result.domain,
    slug: result.slug,
  };
}

const saveAssignment = Effect.fn("ProjectDomain.saveAssignment")(function* (
  store: LocalConfigStore["Service"],
  saved: LocalConfig,
  project: typeof VercelProject.Type,
  teamId: string | undefined,
  assignment: ProjectDomainAssignment,
) {
  const latest = yield* store.read;
  const assignments = (latest.domainAssignments ?? saved.domainAssignments ?? []).filter(
    (item) =>
      item.configIdentity !== assignment.configIdentity ||
      item.targetName !== assignment.targetName ||
      item.targetPath !== assignment.targetPath,
  );
  yield* store.update({
    teamId,
    projectId: project.id,
    domainAssignments: [...assignments, assignment],
  });
});

function projectPath(project: string, teamId: string | undefined): string {
  return withTeam(`/v9/projects/${encodeURIComponent(project)}`, teamId);
}

function projectDomainsPath(projectId: string, teamId: string | undefined): string {
  return withTeam(`/v9/projects/${encodeURIComponent(projectId)}/domains`, teamId);
}

function withTeam(path: string, teamId: string | undefined): string {
  return teamId === undefined ? path : `${path}?teamId=${encodeURIComponent(teamId)}`;
}

function apiShapeError(error: unknown, resource: string): VercelCliFailed {
  return new VercelCliFailed({
    command: "vercel api",
    failure: { _tag: "InvalidJsonOutput", stdout: String(error) },
    message: `Vercel returned an unsupported JSON shape for ${resource}. Upgrade the Vercel CLI and retry. No domain assignment was changed.`,
  });
}

function validDomain(value: string): boolean {
  if (value !== value.toLowerCase() || value.includes("*") || value.length > 253) return false;
  if (!URL.canParse(`https://${value}`)) return false;
  const url = new URL(`https://${value}`);
  return url.hostname === value && url.port === "" && value.includes(".");
}
