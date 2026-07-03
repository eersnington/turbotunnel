import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { resolveHttpTunnelConfig } from "../config.js";
import { startHttpTunnel } from "../local-client/tunnel.js";
import { deployGateway } from "./deploy.js";

export const httpCommand = Command.make(
  "http",
  {
    port: Argument.integer("port").pipe(Argument.withDescription("local port to expose")),
    slug: Flag.string("slug").pipe(Flag.withDescription("tunnel slug to use"), Flag.optional),
    host: Flag.string("host").pipe(
      Flag.withDescription("local host to connect to"),
      Flag.withDefault("localhost"),
    ),
    pool: Flag.integer("pool").pipe(
      Flag.withDescription("number of hidden local client sockets"),
      Flag.optional,
    ),
    domain: Flag.string("domain").pipe(
      Flag.withDescription("tunnel domain or {slug} host pattern"),
      Flag.optional,
    ),
    secret: Flag.string("secret").pipe(Flag.withDescription("relay secret"), Flag.optional),
    relayUrl: Flag.string("relay-url").pipe(
      Flag.withDescription("explicit relay origin override, such as ws://127.0.0.1:3002"),
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
    "Expose a localhost HTTP/WebSocket app through a user-owned Vercel gateway",
  ),
  Command.withExamples([
    {
      command: "turbotunnel http 3000",
      description: "Expose a local app running on port 3000",
    },
    {
      command: "turbotunnel http 3000 --domain localhost",
      description: "Use http/ws for localhost without adding a port",
    },
    {
      command: "turbotunnel http 3000 --domain localhost:3002",
      description: "Use the port included in the tunnel domain",
    },
    {
      command: "turbotunnel http 3000 --relay-url ws://127.0.0.1:3002",
      description: "Connect the local client to an explicit relay origin",
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
    yield* deployGateway({
      project: Option.getOrUndefined(project),
      domain: Option.getOrUndefined(domain),
      region,
    });
  }),
).pipe(Command.withDescription("Deploy the Turbotunnel gateway to Vercel"));
