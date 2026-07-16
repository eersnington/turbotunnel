import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NodeHttpClient } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { LocalAppProbe } from "../src/adapters/local-app-probe.js";

describe("LocalAppProbe", () => {
  it.effect("reaches a local HTTP server through the runtime fetch client", () =>
    Effect.gen(function* () {
      const server = yield* localServer;
      const port = (server.address() as AddressInfo).port;

      yield* Effect.gen(function* () {
        const probe = yield* LocalAppProbe;
        yield* probe.assertReachable({ protocol: "http", host: "localhost", port });
      }).pipe(Effect.provide(LocalAppProbe.live), Effect.provide(NodeHttpClient.layerFetch));
    }),
  );
});

const localServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((_request, response) => {
          response.writeHead(204).end();
        });
        server.once("error", reject);
        server.listen(0, "localhost", () => resolve(server));
      }),
  ),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ).pipe(Effect.orDie),
);
