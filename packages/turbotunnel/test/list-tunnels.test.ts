import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import type { TunnelListResponse } from "@turbotunnel/contracts";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { GatewayControlClient } from "../src/adapters/gateway-control-client.js";
import { listCommand } from "../src/cli/commands.js";
import { CliOutput, type CliMessage } from "../src/cli/output.js";

describe("tt list command", () => {
  it.effect("accepts --format json and executes the list program", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const messages: Array<CliMessage> = [];
        const root = Command.make("turbotunnel").pipe(Command.withSubcommands([listCommand]));
        yield* Command.runWith(root, { version: "test" })(["list", "--format", "json"]).pipe(
          Effect.provide(testServices(messages)),
          Effect.provide(NodeServices.layer),
        );

        expect(messages).toEqual([{ _tag: "Json", stream: "stdout", value: response }]);
      }),
    ),
  );

  it.effect("uses human output for connected and empty terminal states", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = Command.make("turbotunnel").pipe(Command.withSubcommands([listCommand]));
        const connected: Array<CliMessage> = [];
        yield* Command.runWith(root, { version: "test" })(["list"]).pipe(
          Effect.provide(testServices(connected)),
          Effect.provide(NodeServices.layer),
        );
        expect(connected).toHaveLength(1);
        expect(connected[0]).toMatchObject({ _tag: "Text", stream: "stderr" });

        const empty: Array<CliMessage> = [];
        yield* Command.runWith(root, { version: "test" })(["list"]).pipe(
          Effect.provide(testServices(empty, { ...response, tunnels: [] })),
          Effect.provide(NodeServices.layer),
        );
        expect(empty).toHaveLength(1);
        expect(empty[0]).toMatchObject({ _tag: "Text", stream: "stderr" });
      }),
    ),
  );
});

const response: TunnelListResponse = {
  version: 1,
  consistency: "bounded",
  generatedAt: 91_000,
  tunnels: [
    {
      slug: "checkout",
      sessionId: "session_checkout",
      target: { protocol: "http", host: "127.0.0.1", port: 3000 },
      connectedAt: 31_000,
      relayCount: 3,
    },
    {
      slug: "docs",
      sessionId: "session_docs",
      target: { protocol: "http", host: "localhost", port: 5173 },
      connectedAt: 61_000,
      relayCount: 1,
    },
  ],
};

function testServices(messages: Array<CliMessage>, tunnelResponse = response) {
  return Layer.mergeAll(
    Layer.succeed(
      GatewayControlClient,
      GatewayControlClient.of({ listTunnels: Effect.succeed(tunnelResponse) }),
    ),
    Layer.succeed(
      CliOutput,
      CliOutput.of({ write: (message) => Effect.sync(() => messages.push(message)) }),
    ),
  );
}
