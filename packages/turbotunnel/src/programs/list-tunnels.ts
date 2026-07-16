import { Effect } from "effect";

import { GatewayControlClient } from "../adapters/gateway-control-client.js";
import { renderTunnelList, type TunnelListFormat } from "../cli/messages.js";
import { CliOutput } from "../cli/output.js";
import type { ListTunnelsError } from "../errors.js";

export const listTunnels = Effect.fn("listTunnels")(function* (options: {
  readonly format: TunnelListFormat;
}): Effect.fn.Return<void, ListTunnelsError, GatewayControlClient | CliOutput> {
  const client = yield* GatewayControlClient;
  const output = yield* CliOutput;
  const response = yield* client.listTunnels;
  yield* output.write(renderTunnelList({ format: options.format, response }));
});
