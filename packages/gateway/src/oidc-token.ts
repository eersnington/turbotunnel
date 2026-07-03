import { Context, Effect, Layer, Option, Ref } from "effect";

export class OidcToken extends Context.Service<
  OidcToken,
  {
    readonly get: Effect.Effect<Option.Option<string>>;
    readonly set: (token: string) => Effect.Effect<void>;
  }
>()("turbotunnel/gateway/OidcToken") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const token = yield* Ref.make(Option.none<string>());

      return OidcToken.of({
        get: Ref.get(token),
        set: (value) => Ref.set(token, Option.some(value)),
      });
    }),
  );
}
