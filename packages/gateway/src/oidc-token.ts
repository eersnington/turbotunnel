import { Context, Effect, Layer, Option, Redacted, Ref } from "effect";

export class OidcToken extends Context.Service<
  OidcToken,
  {
    readonly get: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    readonly set: (token: string) => Effect.Effect<void>;
  }
>()("turbotunnel/gateway/OidcToken") {
  static readonly layer = (initialToken: string | undefined) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const token = yield* Ref.make(
          initialToken === undefined
            ? Option.none<Redacted.Redacted<string>>()
            : Option.some(Redacted.make(initialToken, { label: "vercel-oidc-token" })),
        );

        return OidcToken.of({
          get: Ref.get(token),
          set: (value) =>
            Ref.set(token, Option.some(Redacted.make(value, { label: "vercel-oidc-token" }))),
        });
      }),
    );
}

/** Controls which request adapters may refresh process-wide queue credentials. */
export class OidcTokenAuthority extends Context.Service<
  OidcTokenAuthority,
  { readonly refresh: (token: string | undefined) => Effect.Effect<void> }
>()("turbotunnel/gateway/OidcTokenAuthority") {
  static readonly none = Layer.succeed(this, this.of({ refresh: () => Effect.void }));

  /** Trusts Vercel's platform-injected function header at the deployment adapter boundary. */
  static readonly vercel = Layer.effect(
    this,
    Effect.gen(function* () {
      const oidcToken = yield* OidcToken;
      return OidcTokenAuthority.of({
        refresh: (token) =>
          token !== undefined && token.length > 0 ? oidcToken.set(token) : Effect.void,
      });
    }),
  );
}
