import { Effect } from "effect";

// Deploy generation rewrites this workspace import to ../src/gateway/index.js.
// Do not deploy this template file directly; use `turbotunnel deploy` so the
// generated Vercel project is standalone and does not depend on @repo/* packages.
import { GatewayLive, makeGatewayServer } from "@turbotunnel/gateway";

export default await Effect.runPromise(
  makeGatewayServer().pipe(Effect.provide(GatewayLive(process.env))),
);
