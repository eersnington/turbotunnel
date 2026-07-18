import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { GatewayState } from "../src/gateway-state.js";
import type { GatewayWebSocket } from "../src/websocket.js";

const routeIdentity = {
  publicHost: "demo.tunnel.test",
  policyFingerprint: "policy-v1:public",
  sessionId: "session_generation_test",
} as const;

const inertSocket: GatewayWebSocket = {
  receive: Effect.never,
  isOpen: Effect.succeed(true),
  sendFrame: () => Effect.succeed(false),
  sendData: () => Effect.succeed(false),
  close: () => Effect.void,
};

describe("GatewayState", () => {
  it.effect("keeps a newer local-client generation when the older registration scope closes", () =>
    Effect.gen(function* () {
      const state = yield* GatewayState;
      const olderScope = yield* Scope.make();
      const newerScope = yield* Scope.make();
      const older = yield* state
        .registerLocalClient(localRegistration(1))
        .pipe(Effect.provideService(Scope.Scope, olderScope));
      const newer = yield* state
        .registerLocalClient(localRegistration(2))
        .pipe(Effect.provideService(Scope.Scope, newerScope));

      const beforeOlderCloses = yield* state.pickLocalClient("demo", routeIdentity);
      yield* Scope.close(olderScope, Exit.void);
      const afterOlderCloses = yield* state.pickLocalClient("demo", routeIdentity);
      yield* Scope.close(newerScope, Exit.void);

      expect(beforeOlderCloses).toBe(newer);
      expect(beforeOlderCloses).not.toBe(older);
      expect(afterOlderCloses).toBe(newer);
    }).pipe(Effect.provide(GatewayState.layer)),
  );

  it.effect("owns public connection capacity for the registration scope", () =>
    Effect.gen(function* () {
      const state = yield* GatewayState;
      const firstRound = yield* Effect.scoped(
        Effect.all(
          [
            state.registerPublicConnection(registration("ws_first")),
            state.registerPublicConnection(registration("ws_second")),
          ],
          { concurrency: "unbounded" },
        ),
      );
      const afterRelease = yield* Effect.scoped(
        state.registerPublicConnection(registration("ws_after_release")),
      );
      expect(firstRound.map((entry) => entry._tag).sort()).toEqual(["AtCapacity", "Registered"]);
      expect(afterRelease._tag).toBe("Registered");
    }).pipe(Effect.provide(GatewayState.layer)),
  );

  it.effect("rejects new direct work on a superseded generation", () =>
    Effect.gen(function* () {
      const state = yield* GatewayState;
      const olderScope = yield* Scope.make();
      const newerScope = yield* Scope.make();
      const older = yield* state
        .registerLocalClient(localRegistration(1))
        .pipe(Effect.provideService(Scope.Scope, olderScope));
      yield* state
        .registerLocalClient(localRegistration(2))
        .pipe(Effect.provideService(Scope.Scope, newerScope));

      const request = yield* state
        .registerDirectRequest(older, "req_superseded")
        .pipe(Effect.scoped);

      expect(request).toBeUndefined();
      yield* Scope.close(olderScope, Exit.void);
      yield* Scope.close(newerScope, Exit.void);
    }).pipe(Effect.provide(GatewayState.layer)),
  );
});

function localRegistration(generation: number) {
  return {
    slug: "demo",
    publicHost: "demo.tunnel.test",
    accessPolicy: { type: "public" },
    socket: inertSocket,
    clientId: "local_generation_test",
    sessionId: "session_generation_test",
    generation,
    connectedAt: 1_000,
    capacity: 1,
    target: { protocol: "http", host: "127.0.0.1", port: 4321 },
  } as const;
}

function registration(connId: string) {
  return {
    connId,
    slug: "demo",
    socket: inertSocket,
    browserOutTopic: `browser-${connId}`,
    localInTopic: `local-${connId}`,
    routeIdentity,
    localClient: undefined,
    capacity: 1,
  } as const;
}
