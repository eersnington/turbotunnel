import pino from "pino";

// Deploy generation rewrites this workspace import to ../src/gateway/index.js.
// Do not deploy this template file directly; use `turbotunnel deploy` so the
// generated Vercel project is standalone and does not depend on @repo/* packages.
import { createGatewayServer, parseGatewayConfig } from "@repo/gateway";

const logger = pino({ name: "turbotunnel-gateway" });
const config = parseGatewayConfig(process.env);

export default await createGatewayServer({ config, logger });
