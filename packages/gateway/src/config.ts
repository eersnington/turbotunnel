import { z } from "zod";

export type GatewayConfig = {
  readonly baseDomain: string;
  readonly relaySecret: string;
  readonly queueRegion: string;
  readonly brokerKind: "memory" | "vercel";
  readonly port: number;
};

const gatewayConfigSchema = z.object({
  TURBOTUNNEL_BASE_DOMAIN: z.string().min(1).default("localhost"),
  TURBOTUNNEL_RELAY_SECRET: z.string().min(1).default("dev_secret"),
  TURBOTUNNEL_QUEUE_REGION: z.string().min(1).default("iad1"),
  TURBOTUNNEL_BROKER: z.enum(["memory", "vercel"]).optional(),
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
});

/** Parse process environment into gateway startup config. */
export function parseGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const parsed = gatewayConfigSchema.safeParse(env);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || issue.code).join(", ");
    throw new Error(
      `Invalid gateway startup configuration. Fix these fields before starting: ${paths}`,
    );
  }

  return {
    baseDomain: parsed.data.TURBOTUNNEL_BASE_DOMAIN,
    relaySecret: parsed.data.TURBOTUNNEL_RELAY_SECRET,
    queueRegion: parsed.data.TURBOTUNNEL_QUEUE_REGION,
    brokerKind:
      parsed.data.TURBOTUNNEL_BROKER ??
      (parsed.data.NODE_ENV === "development" ? "memory" : "vercel"),
    port: parsed.data.PORT,
  };
}
