import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { deployGateway } from "../programs/deploy-gateway.js";
import { showStatus, type StatusFormat } from "../programs/show-status.js";
import { startHttpTunnel, tunnelEnvironmentFromProcess } from "../programs/start-http-tunnel.js";
import { startDev } from "../programs/start-dev.js";
import { CliConfigError } from "../errors.js";
import type { DeployOutput } from "../domain/deploy-plan.js";
import { decodeDevArguments } from "./argv.js";

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
    yield* startHttpTunnel(
      {
        port,
        slug: Option.getOrUndefined(slug),
        host,
        pool: Option.getOrUndefined(pool),
        domain: Option.getOrUndefined(domain),
        secret: Option.getOrUndefined(secret),
        relayUrl: Option.getOrUndefined(relayUrl),
      },
      tunnelEnvironmentFromProcess(process.env),
    );
  }),
).pipe(
  Command.withDescription("Share a local HTTP/WebSocket app through your own Vercel gateway"),
  Command.withExamples([
    { command: "tt http 3000", description: "Share a local app running on port 3000" },
    {
      command: "tt http 3000 --relay-url ws://127.0.0.1:3002",
      description: "Connect to an explicit relay origin",
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
      Flag.withDescription("set output format to json"),
      Flag.optional,
    ),
  },
  Effect.fn("deployCommand")(function* ({ project, domain, region, format }) {
    yield* deployGateway({
      project: Option.getOrUndefined(project),
      domain: Option.getOrUndefined(domain),
      region: Option.getOrUndefined(region),
      output: yield* parseDeployOutput(Option.getOrUndefined(format)),
    });
  }),
).pipe(
  Command.withDescription("Deploy your Turbotunnel gateway to Vercel"),
  Command.withExamples([
    { command: "tt deploy", description: "Deploy a gateway with the default Vercel domain" },
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

export const statusCommand = Command.make(
  "status",
  {
    format: Flag.string("format").pipe(
      Flag.withDescription("set output format to json"),
      Flag.optional,
    ),
  },
  Effect.fn("statusCommand")(function* ({ format }) {
    yield* showStatus({
      format: yield* parseStatusFormat(Option.getOrUndefined(format)),
    });
  }),
).pipe(
  Command.withDescription("Show all live tunnels running on this machine"),
  Command.withExamples([
    { command: "tt status", description: "Show live local tunnels" },
    { command: "tt status --format json", description: "Print machine-readable status" },
  ]),
);

export const devCommand = Command.make(
  "dev",
  {
    port: Flag.integer("port").pipe(
      Flag.withDescription("set the local dev server port, from 1 to 65535"),
      Flag.optional,
    ),
    command: Argument.string("command").pipe(Argument.variadic()),
  },
  Effect.fn("devCommand")(function* ({ port, command }) {
    const exitCode = yield* startDev({
      input: { port: Option.getOrUndefined(port), command: decodeDevArguments(command) },
      cwd: process.cwd(),
      env: tunnelEnvironmentFromProcess(process.env),
    });
    yield* Effect.sync(() => {
      process.exitCode = exitCode;
    });
  }),
).pipe(
  Command.withDescription("Start a project dev server and expose it through Turbotunnel"),
  Command.withExamples([
    { command: "tt dev", description: "Start the package dev script on a free port" },
    { command: "tt dev --port 5173", description: "Start the dev server on port 5173" },
    {
      command: "tt dev -- vite --host 0.0.0.0",
      description: "Start a custom command without a shell",
    },
  ]),
);

export function requestedDeployOutput(argv: ReadonlyArray<string>): DeployOutput {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--format" && argv[index + 1] === "json") {
      return { _tag: "Json" };
    }
    if (argv[index] === "--format=json") {
      return { _tag: "Json" };
    }
  }

  return { _tag: "Terminal" };
}

function parseDeployOutput(
  format: string | undefined,
): Effect.Effect<DeployOutput, CliConfigError> {
  if (format === undefined) {
    return Effect.succeed({ _tag: "Terminal" });
  }
  if (format === "json") {
    return Effect.succeed({ _tag: "Json" });
  }

  return new CliConfigError({ message: "Format must be `json`." });
}

function parseStatusFormat(
  format: string | undefined,
): Effect.Effect<StatusFormat, CliConfigError> {
  if (format === undefined) return Effect.succeed("terminal");
  if (format === "json") return Effect.succeed("json");
  return Effect.fail(new CliConfigError({ message: "Format must be `json`." }));
}

export const turbotunnelCommand = Command.make("turbotunnel").pipe(
  Command.withDescription(
    "Tunnel your local dev server with a public URL, powered by Vercel WebSockets.",
  ),
  Command.withSubcommands([devCommand, httpCommand, deployCommand, statusCommand]),
);
