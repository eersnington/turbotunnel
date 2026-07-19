import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { deployGateway } from "../programs/deploy-gateway.js";
import { showStatus } from "../programs/show-status.js";
import { startHttpTunnel } from "../programs/start-http-tunnel.js";
import { startDev } from "../programs/start-dev.js";
import { listTunnels } from "../programs/list-tunnels.js";
import { CliConfigError } from "../errors.js";
import type { DeployOutput } from "../domain/deploy-plan.js";
import type { AccessOverride } from "../domain/project-access.js";
import { parseDevArguments } from "./argv.js";

export const httpCommand = Command.make(
  "http",
  {
    target: Argument.string("project-or-port").pipe(
      Argument.withDescription("select a configured project or set the local app port"),
      Argument.optional,
    ),
    port: Flag.integer("port").pipe(
      Flag.withDescription("set the local app port, from 1 to 65535"),
      Flag.optional,
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
    publicAccess: Flag.boolean("public").pipe(
      Flag.withDescription("temporarily allow public access without authentication"),
    ),
    password: Flag.string("password").pipe(
      Flag.withDescription("temporarily require password access; pass a value or omit to prompt"),
      Flag.optional,
    ),
    allowIp: Flag.string("allow-ip").pipe(
      Flag.withDescription("temporarily allow an IP address or CIDR; may be repeated"),
      Flag.atMost(64),
    ),
  },
  Effect.fn("httpCommand")(function* ({
    target,
    port,
    slug,
    host,
    pool,
    domain,
    secret,
    relayUrl,
    publicAccess,
    password,
    allowIp,
  }) {
    const selected = Option.getOrUndefined(target);
    const positionalPort =
      selected !== undefined && /^\d+$/u.test(selected) ? Number(selected) : undefined;
    yield* startHttpTunnel(
      {
        port: Option.getOrUndefined(port) ?? positionalPort,
        slug: Option.getOrUndefined(slug),
        host,
        pool: Option.getOrUndefined(pool),
        domain: Option.getOrUndefined(domain),
        secret: Option.getOrUndefined(secret),
        relayUrl: Option.getOrUndefined(relayUrl),
      },
      {
        cwd: process.cwd(),
        projectName: positionalPort === undefined ? selected : undefined,
        accessOverride: yield* parseAccessOverride({
          publicAccess,
          password,
          allowIp,
        }),
      },
    );
  }),
).pipe(
  Command.withDescription("Share a local HTTP/WebSocket app through your own Vercel gateway"),
  Command.withExamples([
    { command: "tt http 3000", description: "Share a local app running on port 3000" },
    { command: "tt http dashboard", description: "Share a configured monorepo project" },
    {
      command: "tt http 3000 --password",
      description: "Share with password access",
    },
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
      format: yield* parseReadOutput(Option.getOrUndefined(format)),
    });
  }),
).pipe(
  Command.withDescription("Show all live tunnels running on this machine"),
  Command.withExamples([
    { command: "tt status", description: "Show live local tunnels" },
    { command: "tt status --format json", description: "Print machine-readable status" },
  ]),
);

export const listCommand = Command.make(
  "list",
  {
    format: Flag.string("format").pipe(
      Flag.withDescription("set output format to json"),
      Flag.optional,
    ),
  },
  Effect.fn("listCommand")(function* ({ format }) {
    yield* listTunnels({
      format: yield* parseReadOutput(Option.getOrUndefined(format)),
    });
  }),
).pipe(
  Command.withDescription("List tunnels connected to the configured gateway"),
  Command.withExamples([
    { command: "tt list", description: "List connected gateway tunnels" },
    { command: "tt list --format json", description: "Print the versioned gateway response" },
  ]),
);

export const devCommand = Command.make(
  "dev",
  {
    port: Flag.integer("port").pipe(
      Flag.withDescription("set the local dev server port, from 1 to 65535"),
      Flag.optional,
    ),
    publicAccess: Flag.boolean("public").pipe(
      Flag.withDescription("temporarily allow public access without authentication"),
    ),
    password: Flag.string("password").pipe(
      Flag.withDescription("temporarily require password access; pass a value or omit to prompt"),
      Flag.optional,
    ),
    allowIp: Flag.string("allow-ip").pipe(
      Flag.withDescription("temporarily allow an IP address or CIDR; may be repeated"),
      Flag.atMost(64),
    ),
    command: Argument.string("project-or-command").pipe(
      Argument.withDescription("select a project; values after -- form a custom child command"),
      Argument.variadic(),
    ),
  },
  Effect.fn("devCommand")(function* ({ port, publicAccess, password, allowIp, command }) {
    const parsed = parseDevArguments(command);
    const exitCode = yield* startDev({
      input: { port: Option.getOrUndefined(port), command: parsed.command },
      cwd: process.cwd(),
      projectName: parsed.project,
      accessOverride: yield* parseAccessOverride({
        publicAccess,
        password,
        allowIp,
      }),
    });
    yield* Effect.sync(() => {
      process.exitCode = exitCode;
    });
  }),
).pipe(
  Command.withDescription("Start a project dev server and expose it through Turbotunnel"),
  Command.withExamples([
    { command: "tt dev", description: "Start the configured project for the current directory" },
    { command: "tt dev dashboard", description: "Start a named monorepo project" },
    { command: "tt dev --port 5173", description: "Start the dev server on port 5173" },
    {
      command: "tt dev --password",
      description: "Start with password access",
    },
    {
      command: "tt dev -- vite --host 0.0.0.0",
      description: "Start a custom command without a shell",
    },
  ]),
);

function parseAccessOverride(options: {
  readonly publicAccess: boolean;
  readonly password: Option.Option<string>;
  readonly allowIp: ReadonlyArray<string>;
}): Effect.Effect<AccessOverride | undefined, CliConfigError> {
  const selected =
    Number(options.publicAccess) +
    Number(Option.isSome(options.password)) +
    Number(options.allowIp.length > 0);
  if (selected > 1) {
    return Effect.fail(
      new CliConfigError({
        message:
          "Use only one access override: --public, --password, or --allow-ip. No tunnel was started.",
      }),
    );
  }
  if (options.publicAccess) return Effect.succeed({ type: "public" });
  if (Option.isSome(options.password)) {
    const value = options.password.value;
    return Effect.succeed({
      type: "password",
      ...(value.length > 0 ? { password: value } : {}),
    });
  }
  if (options.allowIp.length > 0) return Effect.succeed({ type: "ip", allow: options.allowIp });
  return Effect.succeed(undefined);
}

export function requestedOutput(argv: ReadonlyArray<string>): DeployOutput {
  const commandIndex = argv.findIndex(
    (argument) => argument === "deploy" || argument === "status" || argument === "list",
  );
  if (commandIndex === -1) return { _tag: "Terminal" };

  for (let index = commandIndex + 1; index < argv.length && argv[index] !== "--"; index += 1) {
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

function parseReadOutput(
  format: string | undefined,
): Effect.Effect<"terminal" | "json", CliConfigError> {
  if (format === undefined) return Effect.succeed("terminal");
  if (format === "json") return Effect.succeed("json");
  return Effect.fail(new CliConfigError({ message: "Format must be `json`." }));
}

export const turbotunnelCommand = Command.make("turbotunnel").pipe(
  Command.withDescription(
    "Tunnel your local dev server with a public URL, powered by Vercel WebSockets.",
  ),
  Command.withSubcommands([devCommand, httpCommand, deployCommand, statusCommand, listCommand]),
);
