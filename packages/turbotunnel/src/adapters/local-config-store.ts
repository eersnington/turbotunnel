import { dirname } from "node:path";

import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

import type { SavedDeployConfig } from "../domain/deploy-plan.js";
import { ConfigFileParseError, ConfigFileReadError, ConfigFileWriteError } from "../errors.js";
import { AppPaths } from "./app-paths.js";

export type LocalConfig = typeof LocalConfigSchema.Type;

export type LocalConfigStoreShape = {
  readonly read: Effect.Effect<LocalConfig, ConfigFileReadError | ConfigFileParseError>;
  readonly write: (
    config: Required<SavedDeployConfig>,
  ) => Effect.Effect<void, ConfigFileWriteError>;
};

export class LocalConfigStore extends Context.Service<LocalConfigStore, LocalConfigStoreShape>()(
  "turbotunnel/effect/LocalConfigStore",
) {
  static readonly layer = (path: string) => Layer.effect(this, makeLocalConfigStore(path));
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const paths = yield* AppPaths;
      return yield* makeLocalConfigStore(paths.configPath);
    }),
  );
}

export const LocalConfigSchema = Schema.Struct({
  project: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  relayDomain: Schema.optional(Schema.String),
  relaySecret: Schema.optional(Schema.String),
  relayUrl: Schema.optional(Schema.String),
  queueRegion: Schema.optional(Schema.String),
});

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeLocalConfig = Schema.decodeUnknownEffect(LocalConfigSchema);

const makeLocalConfigStore = Effect.fn("LocalConfigStore.make")(function* (
  path: string,
): Effect.fn.Return<LocalConfigStoreShape, never, FileSystem> {
  const fs = yield* FileSystem;
  return LocalConfigStore.of({
    read: readConfig(fs, path),
    write: (config) => writeConfig(fs, path, config),
  });
});

const readConfig = Effect.fn("LocalConfigStore.read")(function* (
  fs: FileSystem,
  path: string,
): Effect.fn.Return<LocalConfig, ConfigFileReadError | ConfigFileParseError> {
  const exists = yield* fs.exists(path).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileReadError({
          path,
          cause,
          message:
            "Couldn't check the Turbotunnel config file. Confirm file permissions and retry. No local tunnel was started.",
        }),
    ),
  );
  if (!exists) {
    return {};
  }

  const text = yield* fs.readFileString(path, "utf8").pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileReadError({
          path,
          cause,
          message:
            "Couldn't read the Turbotunnel config file. Fix the file permissions or remove the file, then retry.",
        }),
    ),
  );
  const json = yield* decodeJsonString(text).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileParseError({
          path,
          cause,
          message:
            "The Turbotunnel config file is not valid JSON. Fix or remove the file, then retry.",
        }),
    ),
  );

  return yield* decodeLocalConfig(json).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileParseError({
          path,
          cause,
          message:
            "The Turbotunnel config file has an unsupported shape. Keep only string fields and retry.",
        }),
    ),
  );
});

const writeConfig = Effect.fn("LocalConfigStore.write")(function* (
  fs: FileSystem,
  path: string,
  config: Required<SavedDeployConfig>,
): Effect.fn.Return<void, ConfigFileWriteError> {
  yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigFileWriteError({
          path: dirname(path),
          cause,
          message:
            "Gateway was deployed, but Turbotunnel could not create the local config directory. Fix file permissions, then run `tt deploy` again to save the config.",
        }),
    ),
  );
  yield* fs
    .writeFileString(
      path,
      `${JSON.stringify(
        {
          project: config.project,
          slug: config.slug,
          relayDomain: config.relayDomain,
          queueRegion: config.queueRegion,
          relaySecret: Redacted.value(Redacted.make(config.relaySecret, { label: "relay-secret" })),
        },
        null,
        2,
      )}\n`,
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ConfigFileWriteError({
            path,
            cause,
            message:
              "Gateway was deployed, but Turbotunnel could not write the local config. Fix file permissions, then run `tt deploy` again to save the config.",
          }),
      ),
    );
});
