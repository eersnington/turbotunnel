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

export class ConfigFileWriteError extends Schema.TaggedErrorClass<ConfigFileWriteError>()(
  "ConfigFileWriteError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class VercelCliNotFound extends Schema.TaggedErrorClass<VercelCliNotFound>()(
  "VercelCliNotFound",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class VercelCliFailed extends Schema.TaggedErrorClass<VercelCliFailed>()(
  "VercelCliFailed",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    message: Schema.String,
  },
) {}

export class DeployOutputParseError extends Schema.TaggedErrorClass<DeployOutputParseError>()(
  "DeployOutputParseError",
  {
    message: Schema.String,
    stdout: Schema.String,
  },
) {}

export class GatewayWorkspaceError extends Schema.TaggedErrorClass<GatewayWorkspaceError>()(
  "GatewayWorkspaceError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class GatewayVerificationError extends Schema.TaggedErrorClass<GatewayVerificationError>()(
  "GatewayVerificationError",
  {
    reason: Schema.Literals([
      "request-failed",
      "timeout",
      "bad-status",
      "body-mismatch",
      "unknown",
    ]),
    url: Schema.String,
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    bodyExcerpt: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class NoGatewayConfigured extends Schema.TaggedErrorClass<NoGatewayConfigured>()(
  "NoGatewayConfigured",
  {
    message: Schema.String,
  },
) {}

export class LocalTargetNotReachable extends Schema.TaggedErrorClass<LocalTargetNotReachable>()(
  "LocalTargetNotReachable",
  {
    host: Schema.String,
    port: Schema.Number,
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

export type DeployGatewayError =
  | ConfigFileReadError
  | ConfigFileParseError
  | ConfigFileWriteError
  | CliConfigError
  | VercelCliNotFound
  | VercelCliFailed
  | DeployOutputParseError
  | GatewayWorkspaceError
  | GatewayVerificationError;

export type StartHttpTunnelError =
  | ConfigFileReadError
  | ConfigFileParseError
  | CliConfigError
  | NoGatewayConfigured
  | LocalTargetNotReachable;

export type CliFailure = DeployGatewayError | StartHttpTunnelError;
