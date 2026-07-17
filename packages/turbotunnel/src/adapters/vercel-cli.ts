import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { DeployOutputParseError, VercelCliFailed, VercelCliNotFound } from "../errors.js";

export type VercelCliShape = {
  readonly requireInstalled: Effect.Effect<void, VercelCliNotFound | VercelCliFailed>;
  readonly currentAccount: Effect.Effect<string, VercelCliNotFound | VercelCliFailed>;
  readonly linkProject: (
    cwd: string,
    project: string,
  ) => Effect.Effect<void, VercelCliNotFound | VercelCliFailed>;
  readonly setProductionEnv: (
    cwd: string,
    name: string,
    value: string | Redacted.Redacted<string>,
  ) => Effect.Effect<void, VercelCliNotFound | VercelCliFailed>;
  readonly addDomain: (
    cwd: string,
    domain: string,
    project: string,
    scope?: string,
  ) => Effect.Effect<void, VercelCliNotFound | VercelCliFailed>;
  readonly apiGet: (path: string) => Effect.Effect<unknown, VercelCliNotFound | VercelCliFailed>;
  readonly verifyDomain: (
    cwd: string,
    domain: string,
    project: string,
    scope?: string,
  ) => Effect.Effect<void, VercelCliNotFound | VercelCliFailed>;
  readonly deployProduction: (
    cwd: string,
  ) => Effect.Effect<string, VercelCliNotFound | VercelCliFailed | DeployOutputParseError>;
};

export type VercelCliOptions = {
  readonly executable: string;
  readonly env?: Record<string, string | undefined>;
};

export class VercelCli extends Context.Service<VercelCli, VercelCliShape>()(
  "turbotunnel/effect/VercelCli",
) {
  static readonly layer = (cliOptions: VercelCliOptions) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner;
        const run = (args: ReadonlyArray<string>, commandOptions?: VercelCommandOptions) =>
          runVercelCommand(spawner, args, cliOptions, commandOptions);

        return VercelCli.of({
          requireInstalled: run(["--version"], {
            commandNotFoundMessage: VERCEL_CLI_MISSING_MESSAGE,
          }).pipe(Effect.asVoid),
          currentAccount: run(["whoami"], {
            commandNotFoundMessage: VERCEL_CLI_MISSING_MESSAGE,
            failureMessage:
              "Vercel CLI is installed, but `vercel whoami` failed. Run `vercel login`, confirm the account can create projects, then retry `tt deploy`. No gateway was deployed and your local tunnel config was not changed.",
          }).pipe(Effect.map((output) => output.stdout.trim())),
          linkProject: (cwd, project) =>
            run(["link", "--yes", "--project", project], { cwd }).pipe(Effect.asVoid),
          setProductionEnv: (cwd, name, value) =>
            Effect.gen(function* () {
              const update = yield* run(["env", "update", name, "production"], {
                cwd,
                stdin: value,
                allowNonZeroExit: true,
              });
              if (update.exitCode === 0) {
                return;
              }

              yield* run(["env", "add", name, "production"], {
                cwd,
                stdin: value,
                failureMessage: `Failed to set ${name} for the Production environment. No local tunnel config was changed. Open the Vercel project Environment Variables, fix the value, then run \`tt deploy\` again.`,
              });
            }),
          addDomain: (cwd, domain, project, scope) =>
            run(
              [
                "domains",
                "add",
                domain,
                project,
                ...(scope === undefined ? [] : ["--team", scope]),
              ],
              {
                cwd,
                includeOutputOnFailure: true,
                failureMessage:
                  "Failed to attach the domain to the Turbotunnel gateway project. No tunnel was made public. Review the Vercel output, fix domain ownership or scope access, then retry.",
              },
            ).pipe(Effect.asVoid),
          apiGet: (path) =>
            run(["api", path, "-X", "GET", "--raw"], {
              includeOutputOnFailure: true,
              failureMessage:
                "Failed to read Vercel project information using the current CLI session. Run `vercel login`, confirm you can access the gateway project, then retry. No domain assignment was changed.",
            }).pipe(Effect.andThen((output) => parseJsonOutput(output.stdout, "vercel api"))),
          verifyDomain: (cwd, domain, project, scope) =>
            run(
              [
                "domains",
                "verify",
                domain,
                "--project",
                project,
                "--strict",
                "--format=json",
                "--non-interactive",
                ...(scope === undefined ? [] : ["--team", scope]),
              ],
              {
                cwd,
                includeOutputOnFailure: true,
                failureMessage: `Vercel attached ${domain} to project ${project}, but could not verify its DNS configuration. Apply the exact correction in the Vercel output, then retry. No tunnel was made public.`,
              },
            ).pipe(
              Effect.andThen((output) => parseJsonOutput(output.stdout, "vercel domains verify")),
              Effect.andThen(parseDomainVerification),
            ),
          deployProduction: (cwd) =>
            run(["deploy", "--prod", "--yes"], {
              cwd,
              includeOutputOnFailure: true,
              failureMessage:
                "Vercel deployment failed before local config was updated. Your previous Turbotunnel config is still intact. Review the Vercel output, then retry `tt deploy`.",
            }).pipe(Effect.andThen((output) => parseDeploymentUrl(output.stdout))),
        });
      }),
    );

  static readonly live = this.layer({ executable: "vercel" });
}

type VercelCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type VercelCommandOptions = {
  readonly cwd?: string;
  readonly stdin?: string | Redacted.Redacted<string>;
  readonly allowNonZeroExit?: boolean;
  readonly includeOutputOnFailure?: boolean;
  readonly commandNotFoundMessage?: string;
  readonly failureMessage?: string;
};

const VERCEL_CLI_MISSING_MESSAGE =
  "Vercel CLI is required to configure Turbotunnel. Install it, run `vercel login`, and retry. No gateway or tunnel configuration was changed.";

const textEncoder = new TextEncoder();

/**
 * Runs Vercel once and collects stdout, stderr, and the exit code together.
 * Effect's `spawner.string` is useful when output is enough, but Vercel failures
 * need both stderr and the real exit code for actionable typed CLI errors.
 */
const runVercelCommand = Effect.fn("VercelCli.run")(function* (
  spawner: ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
  cliOptions: VercelCliOptions,
  commandOptions: VercelCommandOptions = {},
): Effect.fn.Return<VercelCommandResult, VercelCliNotFound | VercelCliFailed> {
  const command = ["vercel", ...args].join(" ");
  const stdin = commandOptions.stdin === undefined ? undefined : stdinText(commandOptions.stdin);
  const child = ChildProcess.make(cliOptions.executable, args, {
    cwd: commandOptions.cwd,
    env: cliOptions.env,
    extendEnv: true,
    stdin:
      stdin === undefined
        ? "inherit"
        : { stream: Stream.make(textEncoder.encode(stdin)), endOnDone: true },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = yield* child.pipe(
    Effect.provideService(ChildProcessSpawner, spawner),
    Effect.mapError((cause) => classifySpawnFailure(command, cause, commandOptions)),
    Effect.flatMap((handle) =>
      Effect.all(
        [
          collectText(handle.stdout, command, "stdout"),
          collectText(handle.stderr, command, "stderr"),
          handle.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new VercelCliFailed({
                  command,
                  failure: { _tag: "OutputReadFailed", stream: "exit-code", cause },
                  message: `Failed to read the exit code from ${command}. ${cause.message}`,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))),
    ),
    Effect.scoped,
  );

  if (output.exitCode !== 0 && commandOptions.allowNonZeroExit !== true) {
    const excerpt =
      commandOptions.includeOutputOnFailure === true ? commandOutputExcerpt(output) : "";
    return yield* new VercelCliFailed({
      command,
      failure: { _tag: "NonZeroExit", exitCode: output.exitCode },
      message: `${commandOptions.failureMessage ?? `${command} failed with exit code ${output.exitCode}.`}${excerpt}`,
    });
  }

  return output;
});

function stdinText(value: string | Redacted.Redacted<string>): string {
  return `${typeof value === "string" ? value : Redacted.value(value)}\n`;
}

const parseDeploymentUrl = Effect.fn("VercelCli.parseDeploymentUrl")(function* (stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    if (URL.canParse(parsed)) {
      return parsed.endsWith("/") ? parsed : `${parsed}/`;
    }
  }

  return yield* new DeployOutputParseError({
    stdout,
    message:
      "Vercel deployment completed, but Turbotunnel could not read the deployment URL from Vercel output. Local config was not changed. Retry `tt deploy`; if this continues, inspect Vercel deployment stdout.",
  });
});

const DomainVerificationOutput = Schema.Struct({ ok: Schema.Boolean });
const decodeDomainVerification = Schema.decodeUnknownEffect(DomainVerificationOutput);

const parseDomainVerification = Effect.fn("VercelCli.parseDomainVerification")(function* (
  output: unknown,
) {
  const verification = yield* decodeDomainVerification(output).pipe(
    Effect.mapError(
      () =>
        new VercelCliFailed({
          command: "vercel domains verify",
          failure: { _tag: "InvalidJsonOutput", stdout: JSON.stringify(output) },
          message:
            "Vercel returned JSON for domain verification without the expected `ok` boolean. Upgrade the Vercel CLI and retry. The previous domain assignment remains intact.",
        }),
    ),
  );
  if (!verification.ok) {
    return yield* new VercelCliFailed({
      command: "vercel domains verify",
      failure: { _tag: "InvalidJsonOutput", stdout: JSON.stringify(output) },
      message:
        "Vercel reported that the custom domain is not verified. Confirm domain ownership and DNS records in Vercel, then retry. The domain was not moved and the previous assignment remains intact.",
    });
  }
});

function parseJsonOutput(stdout: string, command: string): Effect.Effect<unknown, VercelCliFailed> {
  return Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () =>
      new VercelCliFailed({
        command,
        failure: { _tag: "InvalidJsonOutput", stdout },
        message: `${command} returned output that was not valid JSON. Upgrade the Vercel CLI and retry. No domain assignment was changed.`,
      }),
  });
}

function collectText(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  command: string,
  streamName: "stdout" | "stderr",
): Effect.Effect<string, VercelCliFailed> {
  return Stream.mkString(Stream.decodeText(stream)).pipe(
    Effect.mapError(
      (cause) =>
        new VercelCliFailed({
          command,
          failure: { _tag: "OutputReadFailed", stream: streamName, cause },
          message: `Failed to read output from ${command}. ${cause.message}`,
        }),
    ),
  );
}

function classifySpawnFailure(
  command: string,
  cause: PlatformError,
  options: VercelCommandOptions,
): VercelCliNotFound | VercelCliFailed {
  if (cause.reason._tag === "NotFound") {
    return new VercelCliNotFound({
      command: "vercel",
      cause,
      message:
        options.commandNotFoundMessage ??
        "Required executable `vercel` was not found in PATH. Install it and retry.",
    });
  }

  return new VercelCliFailed({
    command,
    failure: { _tag: "SpawnFailed", cause },
    message: options.failureMessage ?? `${command} could not be started. ${cause.message}`,
  });
}

function commandOutputExcerpt(output: VercelCommandResult): string {
  const text = output.stderr.trim() || output.stdout.trim();
  if (text.length === 0) {
    return "";
  }

  return `\n\nVercel output:\n${text.length <= 2_000 ? text : `${text.slice(0, 2_000)}...`}`;
}
