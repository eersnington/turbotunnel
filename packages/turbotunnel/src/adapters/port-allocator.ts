import { createServer } from "node:net";

import { Context, Effect, Layer } from "effect";

import { PortAllocationError } from "../errors.js";

export type PortAllocatorShape = {
  readonly freePort: Effect.Effect<number, PortAllocationError>;
};

const allocateFreePort: Effect.Effect<number, PortAllocationError> = Effect.callback((resume) => {
  const server = createServer();
  server.unref();
  server.once("error", (cause) => {
    resume(
      Effect.fail(
        new PortAllocationError({
          cause,
          message:
            "Couldn't allocate a local port for the dev server. Check local network permissions or pass --port, then retry. No child process or tunnel was started.",
        }),
      ),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(
        Effect.fail(
          new PortAllocationError({
            cause: address,
            message:
              "Couldn't determine the allocated local port. Pass --port and retry. No child process or tunnel was started.",
          }),
        ),
      );
      return;
    }
    server.close((cause) =>
      cause === undefined
        ? resume(Effect.succeed(address.port))
        : resume(
            Effect.fail(
              new PortAllocationError({
                cause,
                message:
                  "Couldn't release the temporary port reservation. Pass --port and retry. No child process or tunnel was started.",
              }),
            ),
          ),
    );
  });
  return Effect.sync(() => server.close());
});

export class PortAllocator extends Context.Service<PortAllocator, PortAllocatorShape>()(
  "turbotunnel/effect/PortAllocator",
) {
  static readonly live = Layer.succeed(this, PortAllocator.of({ freePort: allocateFreePort }));
}
