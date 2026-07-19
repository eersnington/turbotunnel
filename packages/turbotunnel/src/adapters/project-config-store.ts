import { dirname, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

import { CliConfigError, ConfigFileParseError, ConfigFileReadError } from "../errors.js";

export type ProjectAccess = typeof ProjectAccessSchema.Type;

export type ProjectSelection = {
  readonly configPath: string;
  readonly configRoot: string;
  readonly name: string | undefined;
  readonly port: number | undefined;
  readonly slug: string | undefined;
  readonly domain: string | undefined;
  readonly access: ProjectAccess | undefined;
};

type ProjectConfigStoreShape = {
  readonly discover: (
    cwd: string,
    projectName?: string,
  ) => Effect.Effect<
    ProjectSelection | undefined,
    ConfigFileReadError | ConfigFileParseError | CliConfigError
  >;
};

export class ProjectConfigStore extends Context.Service<
  ProjectConfigStore,
  ProjectConfigStoreShape
>()("turbotunnel/effect/ProjectConfigStore") {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return ProjectConfigStore.of({
        discover: (cwd, projectName) => discoverProjectConfig(fs, cwd, projectName),
      });
    }),
  );
}

const ProjectAccessSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("public") }),
  Schema.Struct({ type: Schema.Literal("password") }),
  Schema.Struct({ type: Schema.Literal("ip"), allow: Schema.Array(Schema.String) }),
]);

const ProjectFields = {
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  slug: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  access: Schema.optional(ProjectAccessSchema),
};
const ProjectSchema = Schema.Struct(ProjectFields);
const RepositoryConfigSchema = Schema.Struct({
  access: Schema.optional(ProjectAccessSchema),
  projects: Schema.Record(Schema.String, ProjectSchema),
});
const ProjectFileSchema = Schema.Union([RepositoryConfigSchema, ProjectSchema]);
const decodeProjectFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectFileSchema), {
  onExcessProperty: "error",
});

const discoverProjectConfig = Effect.fn("ProjectConfigStore.discover")(function* (
  fs: FileSystem,
  cwd: string,
  projectName?: string,
): Effect.fn.Return<
  ProjectSelection | undefined,
  ConfigFileReadError | ConfigFileParseError | CliConfigError
> {
  const absoluteCwd = resolve(cwd);
  let directory = absoluteCwd;
  const filesystemRoot = parse(directory).root;
  while (true) {
    const configPath = join(directory, "turbotunnel.json");
    const exists = yield* fs.exists(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigFileReadError({
            path: configPath,
            cause,
            message: `Couldn't check ${configPath}. Fix its permissions and retry. No child process or tunnel was started.`,
          }),
      ),
    );
    if (exists) return yield* readAndSelect(fs, configPath, projectName);
    if (directory === filesystemRoot) return undefined;
    directory = dirname(directory);
  }
});

const readAndSelect = Effect.fn("ProjectConfigStore.readAndSelect")(function* (
  fs: FileSystem,
  configPath: string,
  projectName?: string,
): Effect.fn.Return<ProjectSelection, ConfigFileReadError | ConfigFileParseError | CliConfigError> {
  const text = yield* fs.readFileString(configPath, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileReadError({
          path: configPath,
          cause,
          message: `Couldn't read ${configPath}. Fix its permissions and retry. No child process or tunnel was started.`,
        }),
    ),
  );
  const config = yield* decodeProjectFile(text).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileParseError({
          path: configPath,
          cause,
          message: `Invalid Turbotunnel project configuration in ${configPath}. Fix the reported fields and retry. No child process or tunnel was started.`,
        }),
    ),
  );
  const configRoot = dirname(configPath);
  if (!("projects" in config)) {
    if (projectName !== undefined) {
      return yield* new CliConfigError({
        message: `${configPath} configures one project, so project name ${JSON.stringify(projectName)} cannot be selected. Remove the project name and retry. No child process or tunnel was started.`,
      });
    }
    return yield* makeSelection(configPath, configRoot, undefined, config);
  }

  const entries = Object.entries(config.projects).map(
    ([name, project]) => [name, { ...project, access: project.access ?? config.access }] as const,
  );
  if (entries.length === 0) {
    return yield* new CliConfigError({
      message: `${configPath} does not define any projects. Add a project under "projects" and retry. No child process or tunnel was started.`,
    });
  }
  const selected =
    projectName === undefined
      ? yield* selectProject(configPath, entries)
      : config.projects[projectName] === undefined
        ? yield* unknownProject(
            configPath,
            projectName,
            entries.map(([name]) => name),
          )
        : ([
            projectName,
            {
              ...config.projects[projectName],
              access: config.projects[projectName].access ?? config.access,
            },
          ] as const);
  const [name, project] = selected;
  return yield* makeSelection(configPath, configRoot, name, project);
});

const selectProject = Effect.fn("ProjectConfigStore.selectProject")(function* (
  configPath: string,
  entries: ReadonlyArray<readonly [string, typeof ProjectSchema.Type]>,
): Effect.fn.Return<readonly [string, typeof ProjectSchema.Type], CliConfigError> {
  if (entries.length === 1) return entries[0]!;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return yield* promptForProject(entries);
  }
  const choices = entries.map(([name]) => `  ${name}`).join("\n");
  return yield* Effect.fail(
    new CliConfigError({
      message: `Multiple Turbotunnel projects are configured in ${configPath}. Select one explicitly by name:\n${choices}\nNo child process or tunnel was started.`,
    }),
  );
});

function promptForProject(
  entries: ReadonlyArray<readonly [string, typeof ProjectSchema.Type]>,
): Effect.Effect<readonly [string, typeof ProjectSchema.Type], CliConfigError> {
  const selectionError = () =>
    new CliConfigError({
      message: `Project selection was not recognized. Retry with an explicit project name, for example: ${entries[0]?.[0] ?? "<project>"}. No child process or tunnel was started.`,
    });
  return Effect.gen(function* () {
    process.stdout.write(
      `Select a Turbotunnel project:\n${entries.map(([name, project], index) => `  ${index + 1}. ${projectSummary(name, project)}`).join("\n")}\n`,
    );
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const answer = yield* Effect.tryPromise({
      try: () => terminal.question("Project: "),
      catch: selectionError,
    }).pipe(Effect.ensuring(Effect.sync(() => terminal.close())));
    const trimmed = answer.trim();
    const byNumber = /^\d+$/u.test(trimmed) ? entries[Number(trimmed) - 1] : undefined;
    const selected = byNumber ?? entries.find(([name]) => name === trimmed);
    if (selected === undefined) return yield* selectionError();
    return selected;
  });
}

function unknownProject(
  configPath: string,
  requested: string,
  names: ReadonlyArray<string>,
): Effect.Effect<never, CliConfigError> {
  return Effect.fail(
    new CliConfigError({
      message: `Project ${JSON.stringify(requested)} is not defined in ${configPath}. Available projects: ${names.join(", ")}. No child process or tunnel was started.`,
    }),
  );
}

function makeSelection(
  configPath: string,
  configRoot: string,
  name: string | undefined,
  project: typeof ProjectSchema.Type,
): Effect.Effect<ProjectSelection, CliConfigError> {
  if (project.slug !== undefined && project.domain !== undefined) {
    return Effect.fail(
      new CliConfigError({
        message: `${name === undefined ? "Project" : `projects.${name}`} in ${configPath} cannot define both "slug" and "domain". Use "slug" for a managed vercel.app hostname or "domain" for an exact custom hostname. No Vercel project or tunnel was changed.`,
      }),
    );
  }
  return Effect.succeed({
    configPath,
    configRoot,
    name,
    port: project.port,
    slug: project.slug,
    domain: project.domain,
    access: project.access,
  });
}

function projectSummary(name: string, project: typeof ProjectSchema.Type): string {
  const local = project.port === undefined ? "port not configured" : `localhost:${project.port}`;
  const publicHost =
    project.domain ??
    (project.slug === undefined ? "generated hostname" : `${project.slug}-turbotunnel.vercel.app`);
  const access = project.access?.type ?? "public";
  return `${name}  ${local}  ${publicHost}  ${access}`;
}
