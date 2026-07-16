import {
  PRESENCE_EVENT_TTL_SECONDS,
  PRESENCE_LEASE_WINDOW_MS,
  PRESENCE_RECEIVE_LIMIT,
  PRESENCE_REPLAY_EVENT_LIMIT,
  PRESENCE_TOPIC,
  PRESENCE_VISIBILITY_TIMEOUT_SECONDS,
  tunnelPresenceEventSchema,
  type ListedTunnel,
  type TunnelListResponse,
  type TunnelPresenceEvent,
} from "@turbotunnel/contracts";
import { Clock, Effect, Result, Schema } from "effect";
import { nanoid } from "nanoid";

import { GatewayState, type LocalClient } from "./gateway-state.js";
import {
  Queue,
  type QueueAckError,
  type QueueAuthError,
  type QueueMessage,
  type QueueReceiveError,
  type QueueSendError,
} from "./queue.js";

type PresenceRecord = {
  readonly event: TunnelPresenceEvent;
  readonly sentAt: number;
};

export class PresenceReplayLimitError extends Schema.TaggedErrorClass<PresenceReplayLimitError>()(
  "PresenceReplayLimitError",
  {
    eventLimit: Schema.Int,
    message: Schema.String,
  },
) {}

const decodePresenceEvent = Schema.decodeUnknownResult(tunnelPresenceEventSchema, {
  onExcessProperty: "error",
});

/** Publishes one full-state relay presence transition. */
export function publishPresence(
  localClient: LocalClient,
  type: TunnelPresenceEvent["type"],
): Effect.Effect<void, QueueAuthError | QueueSendError, GatewayState | Queue> {
  return Effect.gen(function* () {
    const queue = yield* Queue;
    const state = yield* GatewayState;
    const sequence = yield* state.nextPresenceSequence(localClient);
    const event: TunnelPresenceEvent = {
      version: 1,
      type,
      slug: localClient.slug,
      sessionId: localClient.sessionId,
      localClientId: localClient.clientId,
      generation: localClient.generation,
      sequence,
      target: localClient.target,
      connectedAt: localClient.connectedAt,
    };
    yield* queue.send(PRESENCE_TOPIC, event, { ttlSeconds: PRESENCE_EVENT_TTL_SECONDS });
    yield* state.recordMetric("queueSends");
  });
}

/** Replays the retained global presence log into a bounded-consistency tunnel snapshot. */
export function listTunnels(): Effect.Effect<
  TunnelListResponse,
  PresenceReplayLimitError | QueueAckError | QueueAuthError | QueueReceiveError,
  GatewayState | Queue
> {
  return Effect.gen(function* () {
    const queue = yield* Queue;
    const state = yield* GatewayState;
    const records: Array<PresenceRecord> = [];
    let replayedEvents = 0;
    const consumerGroup = `tt_presence_list_${nanoid(12)}`;

    while (true) {
      const messages = yield* queue.receive({
        topic: PRESENCE_TOPIC,
        consumerGroup,
        limit: PRESENCE_RECEIVE_LIMIT,
        visibilityTimeoutSeconds: PRESENCE_VISIBILITY_TIMEOUT_SECONDS,
      });
      yield* state.recordMetric("queueReceives");
      if (messages.length === 0) {
        break;
      }
      if (replayedEvents + messages.length > PRESENCE_REPLAY_EVENT_LIMIT) {
        yield* acknowledgeMessages(messages, state);
        return yield* new PresenceReplayLimitError({
          eventLimit: PRESENCE_REPLAY_EVENT_LIMIT,
          message: `Tunnel presence replay exceeded the ${PRESENCE_REPLAY_EVENT_LIMIT}-event safety limit. No partial tunnel list was returned. Retry after heartbeat traffic subsides; if this persists, inspect relay reconnect or heartbeat volume.`,
        });
      }
      replayedEvents += messages.length;
      const decodedMessages = messages.map((message) => ({
        message,
        decoded: decodePresenceEvent(message.payload),
      }));
      yield* acknowledgeMessages(messages, state);
      for (const { message, decoded } of decodedMessages) {
        if (Result.isFailure(decoded)) {
          yield* logMalformedPresenceEvent(message);
          continue;
        }
        records.push({ event: decoded.success, sentAt: message.sentAt });
      }
    }

    const generatedAt = yield* Clock.currentTimeMillis;
    return {
      version: 1,
      consistency: "bounded",
      generatedAt,
      tunnels: reducePresence(records, generatedAt),
    };
  });
}

function acknowledgeMessages(
  messages: ReadonlyArray<QueueMessage>,
  state: GatewayState["Service"],
): Effect.Effect<void, QueueAckError | QueueAuthError> {
  return Effect.forEach(
    messages,
    (message) => message.ack.pipe(Effect.andThen(state.recordMetric("queueAcks"))),
    { concurrency: "unbounded", discard: true },
  );
}

/** Reduces strict events by generation, connection sequence, and broker time. */
export function reducePresence(
  records: ReadonlyArray<PresenceRecord>,
  generatedAt: number,
): ReadonlyArray<ListedTunnel> {
  const relays = new Map<string, PresenceRecord>();
  for (const record of records) {
    const event = record.event;
    const key = `${event.slug}\u0000${event.sessionId}\u0000${event.localClientId}`;
    const current = relays.get(key);
    if (current === undefined || comparePresenceRecord(record, current) >= 0) {
      relays.set(key, record);
    }
  }

  const groups = new Map<string, Array<PresenceRecord>>();
  for (const record of relays.values()) {
    if (record.event.type === "remove" || record.sentAt + PRESENCE_LEASE_WINDOW_MS <= generatedAt) {
      continue;
    }
    const key = `${record.event.slug}\u0000${record.event.sessionId}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [record]);
    } else {
      group.push(record);
    }
  }

  const tunnels: Array<ListedTunnel> = [];
  for (const group of groups.values()) {
    const newest = group.reduce((current, candidate) =>
      candidate.event.generation > current.event.generation ||
      (candidate.event.generation === current.event.generation && candidate.sentAt > current.sentAt)
        ? candidate
        : current,
    );
    tunnels.push({
      slug: newest.event.slug,
      sessionId: newest.event.sessionId,
      target: newest.event.target,
      connectedAt: Math.min(...group.map((record) => record.event.connectedAt)),
      relayCount: group.length,
    });
  }

  return tunnels.sort(
    (left, right) =>
      compareText(left.slug, right.slug) || compareText(left.sessionId, right.sessionId),
  );
}

function comparePresenceRecord(left: PresenceRecord, right: PresenceRecord): number {
  return (
    left.event.generation - right.event.generation ||
    left.event.sequence - right.event.sequence ||
    left.sentAt - right.sentAt
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logMalformedPresenceEvent(message: QueueMessage): Effect.Effect<void> {
  return Effect.logWarning("discarded malformed tunnel presence event").pipe(
    Effect.annotateLogs({ messageId: message.id, sentAt: message.sentAt }),
  );
}
