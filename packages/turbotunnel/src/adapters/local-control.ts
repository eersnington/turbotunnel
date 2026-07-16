import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import { Context, Effect, Layer, Schema, Scope } from "effect";

import {
  decodeControlResponse,
  ControlRequestSchema,
  type ControlResponse,
  type RuntimeRecord,
  type TunnelLifecycleSnapshot,
} from "../domain/tunnel-lifecycle.js";
import { LocalControlError } from "../errors.js";
import { AppPaths } from "./app-paths.js";

type ControlServer = {
  readonly server: Server;
  readonly sockets: Set<Socket>;
};

export type LocalControlShape = {
  readonly open: (options: {
    readonly sessionId: string;
    readonly processToken: string;
    readonly snapshot: () => TunnelLifecycleSnapshot;
  }) => Effect.Effect<{ readonly endpoint: string }, LocalControlError, Scope.Scope>;
  readonly query: (
    record: RuntimeRecord,
  ) => Effect.Effect<TunnelLifecycleSnapshot, LocalControlError>;
};

export class LocalControl extends Context.Service<LocalControl, LocalControlShape>()(
  "turbotunnel/effect/LocalControl",
) {
  static readonly layer = (runtimeDir: string) => Layer.succeed(this, makeLocalControl(runtimeDir));
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const paths = yield* AppPaths;
      return makeLocalControl(paths.runtimeDir);
    }),
  );
}

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeControlRequestSync = Schema.decodeUnknownSync(
  Schema.fromJsonString(ControlRequestSchema),
  {
    onExcessProperty: "error",
  },
);

function makeLocalControl(runtimeDir: string): LocalControlShape {
  return LocalControl.of({
    open: (options) => {
      const endpoint = controlEndpoint(runtimeDir, options.sessionId);
      return Effect.acquireRelease(
        listen(endpoint, runtimeDir, options.processToken, options.snapshot),
        (server) => closeServer(server, endpoint),
      ).pipe(Effect.as({ endpoint }));
    },
    query: (record) => query(record),
  });
}

function controlEndpoint(sessionsDir: string, sessionId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\turbotunnel-${sessionId}`
    : join(sessionsDir, `${sessionId}.sock`);
}

function listen(
  endpoint: string,
  sessionsDir: string,
  processToken: string,
  snapshot: () => TunnelLifecycleSnapshot,
): Effect.Effect<ControlServer, LocalControlError> {
  return Effect.tryPromise({
    try: async () => {
      if (process.platform !== "win32") {
        await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
        await rm(endpoint, { force: true });
      }
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        handleConnection(socket, processToken, snapshot);
      });
      server.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return { server, sockets };
    },
    catch: (cause) =>
      new LocalControlError({
        operation: "listen",
        reason: "temporarily-unavailable",
        endpoint,
        cause,
        message:
          "Could not start the authenticated local tunnel control endpoint. Check permissions for ~/.turbotunnel and retry. No runtime record was created.",
      }),
  });
}

function handleConnection(
  socket: Socket,
  processToken: string,
  snapshot: () => TunnelLifecycleSnapshot,
): void {
  socket.setEncoding("utf8");
  socket.setTimeout(2_000, () => socket.destroy());
  let input = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) return;
    input += chunk;
    if (input.length > 16_384) {
      handled = true;
      writeResponse(socket, { version: 1, status: "error", reason: "invalid_request" });
      return;
    }
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    handled = true;

    let decoded: typeof ControlRequestSchema.Type;
    try {
      decoded = decodeControlRequestSync(input.slice(0, newline));
    } catch {
      writeResponse(socket, { version: 1, status: "error", reason: "invalid_request" });
      return;
    }
    if (decoded.processToken !== processToken) {
      writeResponse(socket, { version: 1, status: "error", reason: "unauthorized" });
      return;
    }
    writeResponse(socket, { version: 1, status: "ok", snapshot: snapshot() });
  });
  socket.on("error", () => undefined);
}

function writeResponse(socket: Socket, response: ControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function closeServer(control: ControlServer, endpoint: string): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of control.sockets) socket.destroy();
        control.server.close(() => resolve());
      }),
  ).pipe(
    Effect.andThen(
      process.platform === "win32"
        ? Effect.void
        : Effect.promise(() => rm(endpoint, { force: true })),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not fully remove the local tunnel control endpoint.").pipe(
        Effect.annotateLogs({ endpoint, cause }),
      ),
    ),
  );
}

function query(record: RuntimeRecord): Effect.Effect<TunnelLifecycleSnapshot, LocalControlError> {
  return Effect.tryPromise({
    try: () => request(record),
    catch: (cause) =>
      new LocalControlError({
        operation: "connect",
        reason: controlFailureReason(cause),
        endpoint: record.controlSocketPath,
        cause,
        message: `Could not reach local tunnel process ${record.pid}. The process may be temporarily busy; retry status before removing its runtime record.`,
      }),
  }).pipe(
    Effect.flatMap((text) =>
      decodeJsonString(text).pipe(
        Effect.flatMap(decodeControlResponse),
        Effect.mapError(
          (cause) =>
            new LocalControlError({
              operation: "protocol",
              reason: "invalid-protocol",
              endpoint: record.controlSocketPath,
              cause,
              message: `Local tunnel process ${record.pid} returned an unsupported control response. Its runtime record can be removed as stale.`,
            }),
        ),
      ),
    ),
    Effect.flatMap((response) => {
      if (
        response.status === "ok" &&
        response.snapshot.sessionId === record.sessionId &&
        response.snapshot.pid === record.pid &&
        response.snapshot.startedAtMs === record.startedAt
      ) {
        return Effect.succeed(response.snapshot);
      }
      return Effect.fail(
        new LocalControlError({
          operation: "protocol",
          reason: "stale-record",
          endpoint: record.controlSocketPath,
          message: `Local tunnel process ${record.pid} rejected its runtime record credentials. The record can be removed as stale.`,
        }),
      );
    }),
  );
}

function controlFailureReason(cause: unknown): LocalControlError["reason"] {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
  ) {
    return "stale-record";
  }
  return "temporarily-unavailable";
}

function request(record: RuntimeRecord): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.controlSocketPath);
    let response = "";
    const timeout = setTimeout(() => socket.destroy(new Error("control request timed out")), 2_000);
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, processToken: record.processToken })}\n`),
    );
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 1_048_576) socket.destroy(new Error("control response was too large"));
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(response.trim());
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
