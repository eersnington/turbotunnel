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

export class VercelCliFailed extends Schema.TaggedErrorClass<VercelCliFailed>()("VercelCliFailed", {
  command: Schema.String,
  failure: Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("SpawnFailed"),
      cause: Schema.Defect(),
    }),
    Schema.Struct({
      _tag: Schema.Literal("OutputReadFailed"),
      stream: Schema.Literals(["stdout", "stderr", "exit-code"]),
      cause: Schema.Defect(),
    }),
    Schema.Struct({
      _tag: Schema.Literal("NonZeroExit"),
      exitCode: Schema.Number,
    }),
  ]),
  message: Schema.String,
}) {}

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

export class RuntimeRegistryError extends Schema.TaggedErrorClass<RuntimeRegistryError>()(
  "RuntimeRegistryError",
  {
    operation: Schema.Literals(["create-directory", "read", "write", "rename", "remove"]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalControlError extends Schema.TaggedErrorClass<LocalControlError>()(
  "LocalControlError",
  {
    operation: Schema.Literals(["listen", "connect", "read", "protocol"]),
    reason: Schema.Literals(["stale-record", "temporarily-unavailable", "invalid-protocol"]),
    endpoint: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ProjectNotFound extends Schema.TaggedErrorClass<ProjectNotFound>()("ProjectNotFound", {
  cwd: Schema.String,
  message: Schema.String,
}) {}

export class ProjectManifestError extends Schema.TaggedErrorClass<ProjectManifestError>()(
  "ProjectManifestError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class UnsupportedPackageManager extends Schema.TaggedErrorClass<UnsupportedPackageManager>()(
  "UnsupportedPackageManager",
  {
    packageManager: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class ConflictingLockfiles extends Schema.TaggedErrorClass<ConflictingLockfiles>()(
  "ConflictingLockfiles",
  {
    root: Schema.String,
    lockfiles: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export class DevScriptNotFound extends Schema.TaggedErrorClass<DevScriptNotFound>()(
  "DevScriptNotFound",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class PortAllocationError extends Schema.TaggedErrorClass<PortAllocationError>()(
  "PortAllocationError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class DevProcessError extends Schema.TaggedErrorClass<DevProcessError>()("DevProcessError", {
  command: Schema.String,
  operation: Schema.Literals(["spawn", "wait"]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class DevServerReadinessTimeout extends Schema.TaggedErrorClass<DevServerReadinessTimeout>()(
  "DevServerReadinessTimeout",
  {
    host: Schema.String,
    port: Schema.Number,
    timeoutSeconds: Schema.Number,
    message: Schema.String,
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

export class RelayWebSocketConnectError extends Schema.TaggedErrorClass<RelayWebSocketConnectError>()(
  "RelayWebSocketConnectError",
  {
    url: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RelayWebSocketWriteError extends Schema.TaggedErrorClass<RelayWebSocketWriteError>()(
  "RelayWebSocketWriteError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalWebSocketConnectError extends Schema.TaggedErrorClass<LocalWebSocketConnectError>()(
  "LocalWebSocketConnectError",
  {
    url: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalWebSocketWriteError extends Schema.TaggedErrorClass<LocalWebSocketWriteError>()(
  "LocalWebSocketWriteError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalWebSocketProtocolError extends Schema.TaggedErrorClass<LocalWebSocketProtocolError>()(
  "LocalWebSocketProtocolError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
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
  | LocalTargetNotReachable
  | RuntimeRegistryError
  | LocalControlError;

export type StatusError = RuntimeRegistryError;

export type StartDevError =
  | ProjectNotFound
  | ProjectManifestError
  | UnsupportedPackageManager
  | ConflictingLockfiles
  | DevScriptNotFound
  | PortAllocationError
  | DevProcessError
  | DevServerReadinessTimeout
  | StartHttpTunnelError;

export type CliFailure = DeployGatewayError | StartHttpTunnelError | StartDevError | StatusError;
