import { ManagedRuntime } from "effect";

// Deploy generation rewrites this workspace import to ../src/gateway/index.js.
// Do not deploy this template file directly; use `turbotunnel deploy` so the
// generated Vercel project is standalone and does not depend on @repo/* packages.
import { GatewayLive, GatewayServer } from "@turbotunnel/gateway";

// Keep the managed runtime alive with Vercel's exported server so scoped resources share its lifetime.
const runtime = ManagedRuntime.make(GatewayLive(process.env));
const server = await runtime.runPromise(GatewayServer);
server.once("close", () => {
  // Disposal has no typed failure; handle a finalizer defect so shutdown never creates an unowned rejection.
  void runtime.dispose().catch(() => undefined);
});

export default server;
