import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { resolveHttpTunnelConfig } from "../config.js";
import { startHttpTunnel } from "../local-client/tunnel.js";
import { deployRelay } from "./deploy.js";

export const httpCommand = Command.make(
  "http",
  {
    port: Argument.integer("port").pipe(Argument.withDescription("local port to expose")),
    slug: Flag.string("slug").pipe(Flag.withDescription("tunnel slug to use"), Flag.optional),
    host: Flag.string("host").pipe(
      Flag.withDescription("local host to connect to"),
      Flag.withDefault("127.0.0.1"),
    ),
    pool: Flag.integer("pool").pipe(
      Flag.withDescription("number of hidden local client sockets"),
      Flag.optional,
    ),
    domain: Flag.string("domain").pipe(Flag.withDescription("base tunnel domain"), Flag.optional),
    secret: Flag.string("secret").pipe(Flag.withDescription("relay secret"), Flag.optional),
    relayUrl: Flag.string("relay-url").pipe(
      Flag.withDescription("relay origin override for local testing"),
      Flag.optional,
    ),
  },
  Effect.fn("httpCommand")(function* ({ port, slug, host, pool, domain, secret, relayUrl }) {
    const config = yield* resolveHttpTunnelConfig({
      port,
      slug: Option.getOrUndefined(slug),
      host,
      pool: Option.getOrUndefined(pool),
      domain: Option.getOrUndefined(domain),
      secret: Option.getOrUndefined(secret),
      relayUrl: Option.getOrUndefined(relayUrl),
    });

    yield* startHttpTunnel(config);
  }),
).pipe(
  Command.withDescription(
    "Expose a localhost HTTP/WebSocket app through a user-owned Vercel relay",
  ),
  Command.withExamples([
    {
      command: "turbotunnel http 3000",
      description: "Expose a local app running on port 3000",
    },
  ]),
);

export const deployCommand = Command.make(
  "deploy",
  {
    project: Flag.string("project").pipe(
      Flag.withDescription("Vercel project name"),
      Flag.optional,
    ),
    domain: Flag.string("domain").pipe(
      Flag.withDescription("base tunnel domain or {slug} host pattern"),
      Flag.optional,
    ),
    region: Flag.string("region").pipe(
      Flag.withDescription("Vercel Queue region"),
      Flag.withDefault("iad1"),
    ),
  },
  Effect.fn("deployCommand")(function* ({ project, domain, region }) {
    yield* deployRelay({
      project: Option.getOrUndefined(project),
      domain: Option.getOrUndefined(domain),
      region,
    });
  }),
).pipe(Command.withDescription("Deploy the Turbotunnel relay to Vercel"));
