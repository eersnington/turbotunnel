import pino from "pino";

import { parseGatewayConfig } from "./src/config.js";
import { createGatewayServer } from "./src/gateway-server.js";

const logger = pino({ name: "turbotunnel-gateway" });
const config = parseGatewayConfig(process.env);
const server = await createGatewayServer({ config, logger });

server.listen(config.port, () => {
  logger.info({ port: config.port, baseDomain: config.baseDomain }, "gateway listening");
});

export default server;
