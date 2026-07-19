import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Entropy } from "../src/adapters/entropy.js";

describe("Entropy", () => {
  it.effect("generates readable tt-prefixed access passwords", () =>
    Effect.gen(function* () {
      const password = yield* (yield* Entropy).accessPassword;
      expect(password).toMatch(
        /^tt_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{20}$/u,
      );
    }).pipe(Effect.provide(Entropy.live), Effect.provide(NodeServices.layer)),
  );
});
