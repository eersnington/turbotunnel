import { basename, join } from "node:path";

import { Context, Effect, Layer, Result, Schema, Scope } from "effect";
import { FileSystem } from "effect/FileSystem";
import { nanoid } from "nanoid";

import { decodeRuntimeRecord, type RuntimeRecord } from "../domain/tunnel-lifecycle.js";
import { RuntimeRegistryError } from "../errors.js";
import { AppPaths } from "./app-paths.js";

export type RuntimeRegistryShape = {
  readonly register: (
    record: RuntimeRecord,
  ) => Effect.Effect<void, RuntimeRegistryError, Scope.Scope>;
  readonly list: Effect.Effect<ReadonlyArray<RuntimeRecord>, RuntimeRegistryError>;
  readonly remove: (record: RuntimeRecord) => Effect.Effect<void, RuntimeRegistryError>;
};

export class RuntimeRegistry extends Context.Service<RuntimeRegistry, RuntimeRegistryShape>()(
  "turbotunnel/effect/RuntimeRegistry",
) {
  static readonly layer = (runtimeDir: string) =>
    Layer.effect(this, makeRuntimeRegistry(runtimeDir));
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const paths = yield* AppPaths;
      return yield* makeRuntimeRegistry(paths.runtimeDir);
    }),
  );
}

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const makeRuntimeRegistry = Effect.fn("RuntimeRegistry.make")(function* (
  sessionsDir: string,
): Effect.fn.Return<RuntimeRegistryShape, never, FileSystem> {
  const fs = yield* FileSystem;
  const recordPath = (sessionId: string) => join(sessionsDir, `${sessionId}.json`);

  const removeRecord = (record: RuntimeRecord) =>
    removeOwnedRecord(fs, recordPath(record.sessionId), record);

  return RuntimeRegistry.of({
    register: (record) =>
      Effect.acquireRelease(
        writeRecordAtomically(fs, sessionsDir, recordPath(record.sessionId), record),
        () => removeRecord(record).pipe(Effect.catch((error) => Effect.logWarning(error.message))),
      ),
    list: listRecords(fs, sessionsDir),
    remove: removeRecord,
  });
});

const listRecords = Effect.fn("RuntimeRegistry.list")(function* (
  fs: FileSystem,
  sessionsDir: string,
): Effect.fn.Return<ReadonlyArray<RuntimeRecord>, RuntimeRegistryError> {
  const exists = yield* fs
    .exists(sessionsDir)
    .pipe(Effect.mapError((cause) => registryError("read", sessionsDir, cause)));
  if (!exists) return [];

  const names = yield* fs
    .readDirectory(sessionsDir)
    .pipe(Effect.mapError((cause) => registryError("read", sessionsDir, cause)));
  const records = yield* Effect.forEach(
    names.filter((name) => name.endsWith(".json")),
    (name) => readRecordOrClean(fs, join(sessionsDir, basename(name)), name),
    { concurrency: 8 },
  );
  return records.filter((record): record is RuntimeRecord => record !== undefined);
});

const readRecordOrClean = Effect.fn("RuntimeRegistry.readRecord")(function* (
  fs: FileSystem,
  path: string,
  fileName: string,
): Effect.fn.Return<RuntimeRecord | undefined, RuntimeRegistryError> {
  const read = yield* fs.readFileString(path, "utf8").pipe(
    Effect.mapError((cause) => registryError("read", path, cause)),
    Effect.result,
  );
  if (Result.isFailure(read)) {
    const stillExists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((cause) => registryError("read", path, cause)));
    if (!stillExists) return undefined;
    return yield* read.failure;
  }
  const text = read.success;
  const decoded = yield* decodeJsonString(text).pipe(
    Effect.flatMap(decodeRuntimeRecord),
    Effect.option,
  );
  if (decoded._tag === "Some" && fileName === `${decoded.value.sessionId}.json`) {
    return decoded.value;
  }

  yield* fs
    .remove(path, { force: true })
    .pipe(Effect.mapError((cause) => registryError("remove", path, cause)));
  return undefined;
});

const writeRecordAtomically = Effect.fn("RuntimeRegistry.write")(function* (
  fs: FileSystem,
  sessionsDir: string,
  path: string,
  record: RuntimeRecord,
): Effect.fn.Return<void, RuntimeRegistryError> {
  yield* fs
    .makeDirectory(sessionsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => registryError("create-directory", sessionsDir, cause)));
  const temporaryPath = `${path}.tmp-${process.pid}-${nanoid(6)}`;
  yield* fs
    .writeFileString(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    .pipe(Effect.mapError((cause) => registryError("write", temporaryPath, cause)));
  yield* fs.rename(temporaryPath, path).pipe(
    Effect.mapError((cause) => registryError("rename", path, cause)),
    Effect.onError(() => fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
  );
});

const removeOwnedRecord = Effect.fn("RuntimeRegistry.remove")(function* (
  fs: FileSystem,
  path: string,
  expected: RuntimeRecord,
): Effect.fn.Return<void, RuntimeRegistryError> {
  const exists = yield* fs
    .exists(path)
    .pipe(Effect.mapError((cause) => registryError("read", path, cause)));
  if (!exists) return;

  const read = yield* fs.readFileString(path, "utf8").pipe(
    Effect.mapError((cause) => registryError("read", path, cause)),
    Effect.result,
  );
  if (Result.isFailure(read)) {
    const stillExists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((cause) => registryError("read", path, cause)));
    if (!stillExists) return;
    return yield* read.failure;
  }
  const text = read.success;
  const current = yield* decodeJsonString(text).pipe(
    Effect.flatMap(decodeRuntimeRecord),
    Effect.option,
  );
  if (current._tag === "None" || current.value.processToken !== expected.processToken) return;

  yield* fs
    .remove(path, { force: true })
    .pipe(Effect.mapError((cause) => registryError("remove", path, cause)));
});

function registryError(
  operation: RuntimeRegistryError["operation"],
  path: string,
  cause: unknown,
): RuntimeRegistryError {
  return new RuntimeRegistryError({
    operation,
    path,
    cause,
    message: `Could not ${operation.replace("-", " ")} the local tunnel runtime registry at ${path}. Check permissions for ~/.turbotunnel and retry. Existing tunnel processes were not stopped.`,
  });
}
