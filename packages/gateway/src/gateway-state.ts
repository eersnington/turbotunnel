/** Owns private runtime registries; scoped registrations own every corresponding cleanup. */
import type { HttpResponse, TunnelRequestFrame } from "@turbotunnel/contracts";
import { Clock, Context, Deferred, Effect, Layer, Scope } from "effect";

import type { GatewayWebSocket, GatewayWebSocketWriteError } from "./websocket.js";

const localClientRecordKey: unique symbol = Symbol("LocalClientRecord");
const publicConnectionRecordKey: unique symbol = Symbol("PublicConnectionRecord");

/** Local application target announced by a connected tunnel client. */
export type LocalTarget = {
  readonly protocol: "http";
  readonly host: string;
  readonly port: number;
};

type LocalClientFields = {
  readonly slug: string;
  readonly socket: GatewayWebSocket;
  readonly clientId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly target: LocalTarget;
};

/** Stable handle for a registered local tunnel client. */
export type LocalClient = LocalClientFields & {
  readonly [localClientRecordKey]: LocalClientRecord;
};

/** Input used to register a local tunnel client for the connection scope. */
export type RegisterLocalClient = LocalClientFields & {
  readonly capacity: number;
};

/** Outcome of a direct HTTP request routed to a local client. */
export type DirectHttpResult =
  | { readonly _tag: "response"; readonly response: HttpResponse }
  | { readonly _tag: "disconnected" };

type PublicConnectionFields = {
  readonly connId: string;
  readonly slug: string;
  readonly socket: GatewayWebSocket;
  readonly browserOutTopic: string;
  readonly localInTopic: string;
  readonly route:
    | { readonly _tag: "Direct"; readonly localClientId: string }
    | { readonly _tag: "Queued" };
};

/** Stable handle for a browser WebSocket registered on this gateway instance. */
export type PublicConnection = PublicConnectionFields & {
  readonly [publicConnectionRecordKey]: PublicConnectionRecord;
};

/** Input used to register a browser WebSocket for the connection scope. */
export type RegisterPublicConnection = Omit<PublicConnectionFields, "route"> & {
  readonly localClient: LocalClient | undefined;
  readonly capacity: number;
};

/** Result of attempting to register a browser WebSocket. */
export type RegisterPublicConnectionResult =
  | { readonly _tag: "Registered"; readonly connection: PublicConnection }
  | { readonly _tag: "AtCapacity" };

/** Local-to-browser sequence transition for an incoming WebSocket frame. */
export type LocalSequenceTransition = "duplicate" | "next" | "gap";

/** Mutable gateway counters exposed only as an immutable status snapshot. */
export type GatewayStatsSnapshot = {
  readonly startedAt: number;
  readonly activeLocalClients: number;
  readonly directHttpRequests: number;
  readonly queuedHttpRequests: number;
  readonly directWebSocketOpens: number;
  readonly queuedWebSocketOpens: number;
  readonly queueReceives: number;
  readonly queueSends: number;
  readonly queueAcks: number;
};

/** Counter names accepted by the state service. */
export type GatewayMetric = Exclude<keyof GatewayStatsSnapshot, "startedAt" | "activeLocalClients">;

type LocalClientRecord = {
  readonly pendingDeliveryAcks: Map<string, Deferred.Deferred<boolean>>;
  readonly pendingDirectHttpRequests: Set<string>;
  inFlight: number;
  readonly capacity: number;
  draining: boolean;
  emptyQueueReceives: number;
};

type PendingHttpRequest = {
  readonly result: Deferred.Deferred<DirectHttpResult>;
};

type PublicConnectionRecord = {
  nextBrowserSeq: number;
  nextLocalSeq: number;
};

type MutableGatewayStats = {
  -readonly [Key in Exclude<
    keyof GatewayStatsSnapshot,
    "activeLocalClients"
  >]: GatewayStatsSnapshot[Key];
};

/** In-process gateway coordination that exposes immutable handles, never mutable registries. */
export class GatewayState extends Context.Service<
  GatewayState,
  {
    readonly registerLocalClient: (
      input: RegisterLocalClient,
    ) => Effect.Effect<LocalClient, never, Scope.Scope>;
    readonly pickLocalClient: (slug: string) => Effect.Effect<LocalClient | undefined>;
    readonly findLocalClient: (clientId: string) => Effect.Effect<LocalClient | undefined>;
    readonly isLocalClientActive: (client: LocalClient) => Effect.Effect<boolean>;
    readonly noteQueueReceive: (
      client: LocalClient,
      receivedMessages: boolean,
    ) => Effect.Effect<number>;
    readonly completeDeliveryAck: (
      client: LocalClient | undefined,
      frameId: string,
      accepted: boolean,
    ) => Effect.Effect<void>;
    readonly sendFrameAndWaitForAck: (
      client: LocalClient,
      frame: TunnelRequestFrame,
      timeoutMs: number,
    ) => Effect.Effect<boolean, GatewayWebSocketWriteError>;
    readonly registerDirectRequest: (
      client: LocalClient,
      requestId: string,
    ) => Effect.Effect<Effect.Effect<DirectHttpResult>, never, Scope.Scope>;
    readonly completeDirectRequest: (response: HttpResponse) => Effect.Effect<boolean>;
    readonly registerPublicConnection: (
      input: RegisterPublicConnection,
    ) => Effect.Effect<RegisterPublicConnectionResult, never, Scope.Scope>;
    readonly findPublicConnection: (connId: string) => Effect.Effect<PublicConnection | undefined>;
    readonly closePublicConnection: (
      connection: PublicConnection,
      code: number | undefined,
      reason: string | undefined,
    ) => Effect.Effect<void>;
    readonly nextBrowserSequence: (connection: PublicConnection) => Effect.Effect<number>;
    readonly acceptLocalSequence: (
      connection: PublicConnection,
      sequence: number,
    ) => Effect.Effect<LocalSequenceTransition>;
    readonly recordMetric: (metric: GatewayMetric) => Effect.Effect<void>;
    readonly snapshotStatus: Effect.Effect<GatewayStatsSnapshot>;
  }
>()("turbotunnel/gateway/GatewayState") {
  /** Fresh state for each gateway runtime layer. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const localClients = new Map<string, LocalClient>();
      const localClientIdsBySlug = new Map<string, Set<string>>();
      const pendingHttpRequests = new Map<string, PendingHttpRequest>();
      const publicWebSockets = new Map<string, PublicConnection>();
      const publicWebSocketCountsBySlug = new Map<string, number>();
      const stats: MutableGatewayStats = {
        startedAt: yield* Clock.currentTimeMillis,
        directHttpRequests: 0,
        queuedHttpRequests: 0,
        directWebSocketOpens: 0,
        queuedWebSocketOpens: 0,
        queueReceives: 0,
        queueSends: 0,
        queueAcks: 0,
      };

      const unregisterPublicConnection = (connection: PublicConnection): Effect.Effect<void> =>
        Effect.sync(() => {
          if (publicWebSockets.get(connection.connId) !== connection) {
            return;
          }
          publicWebSockets.delete(connection.connId);
          const count = publicWebSocketCountsBySlug.get(connection.slug) ?? 0;
          if (count <= 1) {
            publicWebSocketCountsBySlug.delete(connection.slug);
          } else {
            publicWebSocketCountsBySlug.set(connection.slug, count - 1);
          }
        });

      return GatewayState.of({
        registerLocalClient: (input) => {
          const acquire = Effect.sync(() => {
            const record: LocalClientRecord = {
              pendingDeliveryAcks: new Map(),
              pendingDirectHttpRequests: new Set(),
              inFlight: 0,
              capacity: input.capacity,
              draining: false,
              emptyQueueReceives: 0,
            };
            const client: LocalClient = {
              slug: input.slug,
              socket: input.socket,
              clientId: input.clientId,
              sessionId: input.sessionId,
              generation: input.generation,
              target: input.target,
              [localClientRecordKey]: record,
            };
            const clientIds = localClientIdsBySlug.get(client.slug);
            if (clientIds !== undefined) {
              for (const clientId of clientIds) {
                const existing = localClients.get(clientId);
                if (
                  existing !== undefined &&
                  existing.sessionId === client.sessionId &&
                  existing.generation < client.generation
                ) {
                  existing[localClientRecordKey].draining = true;
                }
              }
            }
            localClients.set(client.clientId, client);
            const nextClientIds = clientIds ?? new Set<string>();
            nextClientIds.add(client.clientId);
            localClientIdsBySlug.set(client.slug, nextClientIds);
            return client;
          });

          const release = (client: LocalClient) =>
            Effect.gen(function* () {
              const record = client[localClientRecordKey];
              record.draining = true;
              if (localClients.get(client.clientId) === client) {
                localClients.delete(client.clientId);
                localClientIdsBySlug.get(client.slug)?.delete(client.clientId);
              }
              for (const pending of record.pendingDeliveryAcks.values()) {
                yield* Deferred.succeed(pending, false);
              }
              record.pendingDeliveryAcks.clear();
              for (const requestId of record.pendingDirectHttpRequests) {
                const pending = pendingHttpRequests.get(requestId);
                if (pending !== undefined) {
                  yield* Deferred.succeed(pending.result, { _tag: "disconnected" });
                  pendingHttpRequests.delete(requestId);
                }
              }
              record.pendingDirectHttpRequests.clear();
              record.inFlight = 0;
            });

          return Effect.acquireRelease(acquire, release);
        },
        pickLocalClient: (slug) =>
          Effect.gen(function* () {
            const clientIds = localClientIdsBySlug.get(slug);
            if (clientIds === undefined) {
              return undefined;
            }
            for (const clientId of clientIds) {
              const client = localClients.get(clientId);
              const record = client?.[localClientRecordKey];
              if (
                client !== undefined &&
                record !== undefined &&
                !record.draining &&
                (yield* client.socket.isOpen) &&
                isCurrentLocalClient(client, localClients, localClientIdsBySlug) &&
                record.inFlight < record.capacity
              ) {
                return client;
              }
            }
            return undefined;
          }),
        findLocalClient: (clientId) => Effect.sync(() => localClients.get(clientId)),
        isLocalClientActive: (client) =>
          Effect.gen(function* () {
            const record = client[localClientRecordKey];
            return !record.draining && (yield* client.socket.isOpen);
          }),
        noteQueueReceive: (client, receivedMessages) =>
          Effect.sync(() => {
            const record = client[localClientRecordKey];
            record.emptyQueueReceives = receivedMessages ? 0 : record.emptyQueueReceives + 1;
            return record.emptyQueueReceives;
          }),
        completeDeliveryAck: (client, frameId, accepted) =>
          Effect.gen(function* () {
            if (client === undefined) {
              return;
            }
            const record = client[localClientRecordKey];
            const pending = record.pendingDeliveryAcks.get(frameId);
            if (pending === undefined) {
              return;
            }
            record.pendingDeliveryAcks.delete(frameId);
            yield* Deferred.succeed(pending, accepted);
          }),
        sendFrameAndWaitForAck: (client, frame, timeoutMs) =>
          Effect.gen(function* () {
            const record = client[localClientRecordKey];
            const acknowledgement = yield* Deferred.make<boolean>();
            record.pendingDeliveryAcks.set(frame.frameId, acknowledgement);
            return yield* Effect.gen(function* () {
              if (!(yield* client.socket.sendFrame(frame))) {
                return false;
              }
              return yield* Deferred.await(acknowledgement).pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  orElse: () => Effect.succeed(false),
                }),
              );
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  record.pendingDeliveryAcks.delete(frame.frameId);
                }),
              ),
            );
          }),
        registerDirectRequest: (client, requestId) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const result = yield* Deferred.make<DirectHttpResult>();
              const record = client[localClientRecordKey];
              pendingHttpRequests.set(requestId, { result });
              record.pendingDirectHttpRequests.add(requestId);
              record.inFlight += 1;
              return Deferred.await(result);
            }),
            () =>
              Effect.sync(() => {
                const record = client[localClientRecordKey];
                if (!record.pendingDirectHttpRequests.delete(requestId)) {
                  return;
                }
                pendingHttpRequests.delete(requestId);
                record.inFlight = Math.max(0, record.inFlight - 1);
              }),
          ),
        completeDirectRequest: (response) =>
          Effect.gen(function* () {
            const pending = pendingHttpRequests.get(response.requestId);
            if (pending === undefined) {
              return false;
            }
            yield* Deferred.succeed(pending.result, { _tag: "response", response });
            return true;
          }),
        registerPublicConnection: (input) =>
          Effect.suspend<RegisterPublicConnectionResult, never, Scope.Scope>(() => {
            const existingCount = publicWebSocketCountsBySlug.get(input.slug) ?? 0;
            if (existingCount >= input.capacity) {
              return Effect.succeed({ _tag: "AtCapacity" as const });
            }
            const acquire = Effect.sync(() => {
              const record: PublicConnectionRecord = {
                nextBrowserSeq: 0,
                nextLocalSeq: 0,
              };
              const connection: PublicConnection = {
                connId: input.connId,
                slug: input.slug,
                socket: input.socket,
                browserOutTopic: input.browserOutTopic,
                localInTopic: input.localInTopic,
                route:
                  input.localClient === undefined
                    ? { _tag: "Queued" }
                    : { _tag: "Direct", localClientId: input.localClient.clientId },
                [publicConnectionRecordKey]: record,
              };
              publicWebSockets.set(connection.connId, connection);
              publicWebSocketCountsBySlug.set(connection.slug, existingCount + 1);
              return { _tag: "Registered" as const, connection };
            });
            return Effect.acquireRelease(acquire, (result) =>
              unregisterPublicConnection(result.connection),
            );
          }),
        findPublicConnection: (connId) => Effect.sync(() => publicWebSockets.get(connId)),
        closePublicConnection: (connection, code, reason) =>
          unregisterPublicConnection(connection).pipe(
            Effect.andThen(connection.socket.close(code, reason)),
          ),
        nextBrowserSequence: (connection) =>
          Effect.sync(() => {
            const record = connection[publicConnectionRecordKey];
            const sequence = record.nextBrowserSeq;
            record.nextBrowserSeq += 1;
            return sequence;
          }),
        acceptLocalSequence: (connection, sequence) =>
          Effect.sync(() => {
            const record = connection[publicConnectionRecordKey];
            if (sequence < record.nextLocalSeq) {
              return "duplicate";
            }
            if (sequence > record.nextLocalSeq) {
              return "gap";
            }
            record.nextLocalSeq += 1;
            return "next";
          }),
        recordMetric: (metric) =>
          Effect.sync(() => {
            stats[metric] += 1;
          }),
        snapshotStatus: Effect.gen(function* () {
          let activeLocalClients = 0;
          for (const client of localClients.values()) {
            if (!client[localClientRecordKey].draining && (yield* client.socket.isOpen)) {
              activeLocalClients += 1;
            }
          }
          return { ...stats, activeLocalClients };
        }),
      });
    }),
  );
}

/** Selects only the newest non-draining generation for a local-client session. */
function isCurrentLocalClient(
  client: LocalClient,
  localClients: ReadonlyMap<string, LocalClient>,
  localClientIdsBySlug: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const clientIds = localClientIdsBySlug.get(client.slug);
  if (clientIds === undefined) {
    return false;
  }
  for (const clientId of clientIds) {
    const existing = localClients.get(clientId);
    if (
      existing !== undefined &&
      existing.sessionId === client.sessionId &&
      existing.generation > client.generation &&
      !existing[localClientRecordKey].draining
    ) {
      return false;
    }
  }
  return true;
}
