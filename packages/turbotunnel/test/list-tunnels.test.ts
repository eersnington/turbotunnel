import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import type { TunnelListResponse } from "@turbotunnel/contracts";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { GatewayControlClient } from "../src/adapters/gateway-control-client.js";
import { listCommand } from "../src/cli/commands.js";
import { renderTunnelList } from "../src/cli/messages.js";
import { CliOutput, type CliMessage } from "../src/cli/output.js";
import { listTunnels } from "../src/programs/list-tunnels.js";

describe("listTunnels", () => {
  it.effect("preserves the versioned bounded response in JSON mode", () =>
    Effect.gen(function* () {
      const messages: Array<CliMessage> = [];
      yield* listTunnels({ format: "json" }).pipe(Effect.provide(testServices(messages)));

      expect(messages).toEqual([{ _tag: "Json", stream: "stdout", value: response }]);
    }),
  );
});

describe("renderTunnelList", () => {
  it("renders stable borderless columns to stderr", () => {
    expect(renderTunnelList({ format: "terminal", response })).toEqual({
      _tag: "Text",
      stream: "stderr",
      text: [
        "SLUG      TARGET          CONNECTED  RELAYS",
        "checkout  127.0.0.1:3000  1m         3",
        "docs      localhost:5173  30s        1",
      ].join("\n"),
    });
  });

  it("renders the human empty state to stderr", () => {
    expect(
      renderTunnelList({ format: "terminal", response: { ...response, tunnels: [] } }),
    ).toEqual({
      _tag: "Text",
      stream: "stderr",
      text: "No tunnels are connected.",
    });
  });
});

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

function testServices(messages: Array<CliMessage>) {
  return Layer.mergeAll(
    Layer.succeed(
      GatewayControlClient,
      GatewayControlClient.of({ listTunnels: Effect.succeed(response) }),
    ),
    Layer.succeed(
      CliOutput,
      CliOutput.of({ write: (message) => Effect.sync(() => messages.push(message)) }),
    ),
  );
}
