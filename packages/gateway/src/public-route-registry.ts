import {
  accessPolicyFingerprint,
  PRESENCE_LEASE_WINDOW_MS,
  PRESENCE_RECEIVE_LIMIT,
  PRESENCE_REPLAY_EVENT_LIMIT,
  PRESENCE_TOPIC,
  PRESENCE_VISIBILITY_TIMEOUT_SECONDS,
  tunnelPresenceEventSchema,
  type AccessPolicy,
  type RouteIdentity,
  type TunnelPresenceEvent,
} from "@turbotunnel/contracts";
import { Clock, Context, Deferred, Effect, Layer, Option, Result, Schema } from "effect";
import { nanoid } from "nanoid";

import { GatewayState } from "./gateway-state.js";
import { Queue } from "./queue.js";

type PresenceRecord = { readonly event: TunnelPresenceEvent; readonly sentAt: number };

export type PublicRoute = {
  readonly slug: string;
  readonly accessPolicy: AccessPolicy;
  readonly identity: RouteIdentity;
};

export type PublicRouteLookup =
  | { readonly _tag: "Found"; readonly route: PublicRoute }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Conflicting" }
  | { readonly _tag: "NotReady" };

const decodePresenceEvent = Schema.decodeUnknownResult(tunnelPresenceEventSchema, {
  onExcessProperty: "error",
});

/** Per-instance exact-host registry reconstructed incrementally from retained policy leases. */
export class PublicRouteRegistry extends Context.Service<
  PublicRouteRegistry,
  { readonly lookup: (host: string) => Effect.Effect<PublicRouteLookup> }
>()("turbotunnel/gateway/PublicRouteRegistry") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const queue = yield* Queue;
      const state = yield* GatewayState;
      const records = new Map<string, PresenceRecord>();
      const consumerGroup = `tt_route_registry_${nanoid(12)}`;
      // Completes on empty receive, over-limit, pass error, or catch-up budget.
      // Budget/error complete the wait without serving a partial map (NotReady until empty).
      const firstCatchUp = yield* Deferred.make<void>();
      let catchUpCompleted = false;
      let overLimit = false;
      let catchUpIncomplete = false;
      let catchUpPasses = 0;
      const CATCH_UP_PASS_BUDGET = 100;
      const CATCH_UP_WAIT_MS = 2_000;

      const markCatchUpComplete = Effect.gen(function* () {
        if (catchUpCompleted) return;
        catchUpCompleted = true;
        yield* Deferred.succeed(firstCatchUp, undefined);
      });

      const runPass = Effect.gen(function* () {
        const messages = yield* queue.receive({
          topic: PRESENCE_TOPIC,
          consumerGroup,
          limit: PRESENCE_RECEIVE_LIMIT,
          visibilityTimeoutSeconds: PRESENCE_VISIBILITY_TIMEOUT_SECONDS,
        });
        yield* state.recordMetric("queueReceives");
        if (messages.length === 0) {
          compactRecords(records, yield* Clock.currentTimeMillis);
          overLimit = records.size > PRESENCE_REPLAY_EVENT_LIMIT;
          catchUpIncomplete = false;
          yield* markCatchUpComplete;
          return false;
        }
        for (const message of messages) {
          const decoded = decodePresenceEvent(message.payload);
          if (Result.isSuccess(decoded))
            applyRecord(records, {
              event: decoded.success,
              sentAt: message.sentAt,
            });
          else
            yield* Effect.logWarning("discarded malformed route presence event").pipe(
              Effect.annotateLogs({ messageId: message.id, sentAt: message.sentAt }),
            );
          yield* message.ack;
          yield* state.recordMetric("queueAcks");
        }
        overLimit = records.size > PRESENCE_REPLAY_EVENT_LIMIT;
        catchUpPasses += 1;
        if (overLimit) {
          catchUpIncomplete = false;
          yield* markCatchUpComplete;
        } else if (catchUpPasses >= CATCH_UP_PASS_BUDGET) {
          catchUpIncomplete = true;
          yield* markCatchUpComplete;
        }
        return true;
      });

      const worker = Effect.gen(function* () {
        while (true) {
          const hot = yield* runPass.pipe(
            Effect.catch((error) => {
              catchUpIncomplete = true;
              return Effect.logError("public route registry queue pass failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag }),
                Effect.andThen(markCatchUpComplete),
                Effect.as(false),
              );
            }),
          );
          if (!hot) yield* Effect.sleep(100);
        }
      });
      yield* Effect.forkScoped(worker);

      return PublicRouteRegistry.of({
        lookup: (host) =>
          Effect.gen(function* () {
            const ready = yield* Deferred.await(firstCatchUp).pipe(
              Effect.timeoutOption(CATCH_UP_WAIT_MS),
            );
            if (Option.isNone(ready)) return { _tag: "NotReady" };
            if (overLimit || catchUpIncomplete) return { _tag: "NotReady" };
            const now = yield* Clock.currentTimeMillis;
            compactRecords(records, now);
            if (records.size > PRESENCE_REPLAY_EVENT_LIMIT) return { _tag: "NotReady" };
            const active = [...records.values()].filter(({ event }) => event.type !== "remove");
            const matching = active.filter(({ event }) => event.publicHost === host);
            const first = matching[0];
            if (first === undefined) return { _tag: "Missing" };
            const fingerprint = accessPolicyFingerprint(first.event.accessPolicy);
            const identity: RouteIdentity = {
              publicHost: first.event.publicHost,
              policyFingerprint: fingerprint,
              sessionId: first.event.sessionId,
            };
            const conflictingHost = matching.some(
              ({ event }) =>
                event.slug !== first.event.slug ||
                event.sessionId !== identity.sessionId ||
                accessPolicyFingerprint(event.accessPolicy) !== fingerprint,
            );
            const conflictingSlug = active.some(
              ({ event }) =>
                event.slug === first.event.slug &&
                (event.publicHost !== identity.publicHost ||
                  event.sessionId !== identity.sessionId ||
                  accessPolicyFingerprint(event.accessPolicy) !== fingerprint),
            );
            return conflictingHost || conflictingSlug
              ? { _tag: "Conflicting" }
              : {
                  _tag: "Found",
                  route: {
                    slug: first.event.slug,
                    accessPolicy: first.event.accessPolicy,
                    identity,
                  },
                };
          }),
      });
    }),
  );
}

function applyRecord(records: Map<string, PresenceRecord>, candidate: PresenceRecord): void {
  const event = candidate.event;
  const key = `${event.slug}\u0000${event.sessionId}\u0000${event.localClientId}`;
  const current = records.get(key);
  if (current === undefined || compareRecord(candidate, current) >= 0) records.set(key, candidate);
}

function compactRecords(records: Map<string, PresenceRecord>, now: number): void {
  for (const [key, record] of records) {
    if (record.sentAt + PRESENCE_LEASE_WINDOW_MS <= now) records.delete(key);
  }
}

function compareRecord(left: PresenceRecord, right: PresenceRecord): number {
  return (
    left.event.generation - right.event.generation ||
    left.event.sequence - right.event.sequence ||
    left.sentAt - right.sentAt
  );
}
