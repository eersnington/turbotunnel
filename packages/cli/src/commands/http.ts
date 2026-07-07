import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { type LocalTarget, resolveHttpTunnelConfig } from "../config.js";
import { CliConfigError, LocalTargetNotReachable } from "../errors.js";
import { startHttpTunnel } from "../local-client/tunnel.js";
import type { DeployOutputFormat } from "./deploy.js";
import { deployGateway } from "./deploy.js";

export const httpCommand = Command.make(
  "http",
  {
    port: Argument.integer("port").pipe(
      Argument.withDescription("set the local app port, from 1 to 65535"),
    ),
    slug: Flag.string("slug").pipe(
      Flag.withDescription("set the public tunnel slug"),
      Flag.optional,
    ),
    host: Flag.string("host").pipe(
      Flag.withDescription("set the local app host, defaults to localhost"),
      Flag.withDefault("localhost"),
    ),
    pool: Flag.integer("pool").pipe(
      Flag.withDescription("set local relay socket count, from 1 to 16"),
      Flag.optional,
    ),
    domain: Flag.string("domain").pipe(
      Flag.withDescription("override the base tunnel domain or {slug} host pattern"),
      Flag.optional,
    ),
    secret: Flag.string("secret").pipe(
      Flag.withDescription("use a relay secret for local gateway development"),
      Flag.optional,
    ),
    relayUrl: Flag.string("relay-url").pipe(
      Flag.withDescription("connect to an explicit relay origin for local gateway development"),
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

    yield* assertLocalTargetReachable(config.target);
    yield* startHttpTunnel(config);
  }),
).pipe(
  Command.withDescription("Share a local HTTP/WebSocket app through your own Vercel gateway"),
  Command.withExamples([
    {
      command: "tt http 3000",
      description: "Share a local app running on port 3000",
    },
    {
      command: "tt http 3000 --domain localhost",
      description: "Use http/ws for localhost without adding a port",
    },
    {
      command: "tt http 3000 --domain localhost:3002",
      description: "Use the port included in the tunnel domain",
    },
    {
      command: "tt http 3000 --relay-url ws://127.0.0.1:3002",
      description: "Connect the local client to an explicit relay origin",
    },
  ]),
);

export const deployCommand = Command.make(
  "deploy",
  {
    project: Flag.string("project").pipe(
      Flag.withDescription("set the Vercel project name"),
      Flag.optional,
    ),
    domain: Flag.string("domain").pipe(
      Flag.withDescription("set the base tunnel domain or {slug} host pattern"),
      Flag.optional,
    ),
    region: Flag.string("region").pipe(
      Flag.withDescription("set the Vercel Queue region, defaults to iad1"),
      Flag.optional,
    ),
    format: Flag.string("format").pipe(
      Flag.withDescription("set output format, human or json"),
      Flag.withDefault("human"),
    ),
  },
  Effect.fn("deployCommand")(function* ({ project, domain, region, format }) {
    const outputFormat = yield* parseDeployOutputFormat(format);
    yield* deployGateway({
      project: Option.getOrUndefined(project),
      domain: Option.getOrUndefined(domain),
      region: Option.getOrUndefined(region),
      format: outputFormat,
    });
  }),
).pipe(
  Command.withDescription("Deploy your Turbotunnel gateway to Vercel"),
  Command.withExamples([
    {
      command: "tt deploy",
      description: "Deploy a gateway with the default Vercel domain",
    },
    {
      command: "tt deploy --domain tunnel.example.com",
      description: "Deploy a gateway for a wildcard custom domain",
    },
    {
      command: 'tt deploy --domain "{slug}.dev.example.com"',
      description: "Deploy a gateway with a slug host pattern",
    },
  ]),
);

function parseDeployOutputFormat(
  format: string,
): Effect.Effect<DeployOutputFormat, CliConfigError> {
  if (format === "human" || format === "json") {
    return Effect.succeed(format);
  }

  return Effect.fail(new CliConfigError({ message: "Format must be `human` or `json`." }));
}

const LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS = 3_000;

const assertLocalTargetReachable = Effect.fn("assertLocalTargetReachable")(function* (
  target: LocalTarget,
): Effect.fn.Return<void, LocalTargetNotReachable> {
  yield* Effect.tryPromise({
    try: (signal) =>
      globalThis.fetch(`http://${target.host}:${target.port}/`, {
        signal,
      }),
    catch: (cause) =>
      new LocalTargetNotReachable({
        host: target.host,
        port: target.port,
        cause,
        message: `Local app is not reachable at http://${target.host}:${target.port}.\nStart the app first, or pass --host if it is listening on a different interface.\nNo tunnel was started.`,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new LocalTargetNotReachable({
            host: target.host,
            port: target.port,
            cause: { timeoutMs: LOCAL_TARGET_PREFLIGHT_TIMEOUT_MS },
            message: `Local app is not reachable at http://${target.host}:${target.port}.\nStart the app first, or pass --host if it is listening on a different interface.\nNo tunnel was started.`,
          }),
        ),
    }),
  );
});
