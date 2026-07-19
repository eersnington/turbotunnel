import { Buffer } from "node:buffer";

import { Context, Effect, Layer, Redacted } from "effect";
import { Crypto } from "effect/Crypto";
import { customAlphabet } from "nanoid";

export type EntropyShape = {
  readonly deploySlug: Effect.Effect<string>;
  readonly tunnelSlug: Effect.Effect<string>;
  readonly relaySecret: Effect.Effect<Redacted.Redacted<string>>;
  readonly accessPassword: Effect.Effect<string>;
};

export class Entropy extends Context.Service<Entropy, EntropyShape>()(
  "turbotunnel/effect/Entropy",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const crypto = yield* Crypto;
      return Entropy.of({
        deploySlug: Effect.sync(() => `tt${deploySlugAlphabet()}`),
        tunnelSlug: Effect.sync(() => tunnelSlugAlphabet()),
        accessPassword: Effect.sync(() => `tt_${accessPasswordAlphabet()}`),
        relaySecret: crypto.randomBytes(24).pipe(
          Effect.map((bytes) =>
            Redacted.make(`ttsec_${Buffer.from(bytes).toString("base64url")}`, {
              label: "relay-secret",
            }),
          ),
          Effect.orDie,
        ),
      });
    }),
  );
}

const deploySlugAlphabet = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);
const tunnelSlugAlphabet = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 5);
const accessPasswordAlphabet = customAlphabet(
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
  20,
);
