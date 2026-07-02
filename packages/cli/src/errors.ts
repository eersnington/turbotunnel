import kleur from "kleur";
import { Schema } from "effect";

export class CliConfigError extends Schema.TaggedErrorClass<CliConfigError>()("CliConfigError", {
  message: Schema.String,
}) {}

export class ConfigFileReadError extends Schema.TaggedErrorClass<ConfigFileReadError>()(
  "ConfigFileReadError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ConfigFileParseError extends Schema.TaggedErrorClass<ConfigFileParseError>()(
  "ConfigFileParseError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalHttpRequestFailed extends Schema.TaggedErrorClass<LocalHttpRequestFailed>()(
  "LocalHttpRequestFailed",
  {
    host: Schema.String,
    port: Schema.Number,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalHttpRequestTimedOut extends Schema.TaggedErrorClass<LocalHttpRequestTimedOut>()(
  "LocalHttpRequestTimedOut",
  {
    host: Schema.String,
    port: Schema.Number,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalHttpResponseTooLarge extends Schema.TaggedErrorClass<LocalHttpResponseTooLarge>()(
  "LocalHttpResponseTooLarge",
  {
    limitBytes: Schema.Number,
    message: Schema.String,
  },
) {}

export class VercelCommandNotFound extends Schema.TaggedErrorClass<VercelCommandNotFound>()(
  "VercelCommandNotFound",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class VercelCommandFailed extends Schema.TaggedErrorClass<VercelCommandFailed>()(
  "VercelCommandFailed",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    message: Schema.String,
  },
) {}

export class DeploymentGenerationFailed extends Schema.TaggedErrorClass<DeploymentGenerationFailed>()(
  "DeploymentGenerationFailed",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type CliError =
  | CliConfigError
  | ConfigFileReadError
  | ConfigFileParseError
  | LocalHttpRequestFailed
  | LocalHttpRequestTimedOut
  | LocalHttpResponseTooLarge
  | VercelCommandNotFound
  | VercelCommandFailed
  | DeploymentGenerationFailed;

export function renderCliError(error: CliError): string {
  return kleur.red(error.message);
}

export function isCliError(error: unknown): error is CliError {
  return (
    error instanceof CliConfigError ||
    error instanceof ConfigFileReadError ||
    error instanceof ConfigFileParseError ||
    error instanceof LocalHttpRequestFailed ||
    error instanceof LocalHttpRequestTimedOut ||
    error instanceof LocalHttpResponseTooLarge ||
    error instanceof VercelCommandNotFound ||
    error instanceof VercelCommandFailed ||
    error instanceof DeploymentGenerationFailed
  );
}

export function renderUnknownCliFailure(cause: unknown): string {
  if (cause instanceof Error) {
    return kleur.red(cause.message);
  }

  return kleur.red(
    "Unexpected CLI failure. No relay was deployed and no local tunnel was started.",
  );
}
