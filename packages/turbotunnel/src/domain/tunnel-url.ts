import { Redacted } from "effect";

import type { HttpTunnelConfig } from "./tunnel-config.js";

type TunnelHostConfig = Pick<HttpTunnelConfig, "slug" | "relayDomain">;
type GatewayUrlConfig = TunnelHostConfig & Pick<HttpTunnelConfig, "relayUrl">;

export function tunnelHost(config: TunnelHostConfig): string {
  if (config.relayDomain.includes("{slug}")) {
    return config.relayDomain.replaceAll("{slug}", config.slug);
  }

  return `${config.slug}.${config.relayDomain}`;
}

export function relaySocketUrl(config: HttpTunnelConfig): string {
  if (config.relayUrl !== undefined) {
    const url = new URL(config.relayUrl);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    if (url.pathname === "") {
      url.pathname = "/";
    }

    return url.toString();
  }

  const host = config.publicHost;
  return `${localHostName(host) ? "ws" : "wss"}://${host}/`;
}

export function relayHeaders(config: HttpTunnelConfig): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${Redacted.value(config.relaySecret)}`,
  };

  if (config.relayUrl !== undefined) {
    headers.host = config.publicHost;
  }

  return headers;
}

export function publicTunnelUrl(config: HttpTunnelConfig): string {
  const host = publicTunnelHost(config);
  if (config.relayUrl !== undefined && localHostName(host)) {
    const relayUrl = new URL(config.relayUrl);
    const protocol =
      relayUrl.protocol === "wss:" || relayUrl.protocol === "https:" ? "https" : "http";
    return `${protocol}://${host}/`;
  }

  return `${localHostName(host) ? "http" : "https"}://${host}/`;
}

export function publicTunnelHost(config: HttpTunnelConfig): string {
  const host = config.publicHost;
  if (config.relayUrl === undefined || !localHostName(host)) return host;

  const relayUrl = new URL(config.relayUrl);
  const port = relayUrl.port === "" ? "" : `:${relayUrl.port}`;
  return `${host.replace(/:\d+$/u, "")}${port}`;
}

export function gatewayUrl(config: GatewayUrlConfig): string {
  if (config.relayUrl !== undefined) {
    const url = new URL(config.relayUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    if (url.pathname === "") {
      url.pathname = "/";
    }

    return url.toString();
  }

  const host = tunnelHost(config);
  return `${localHostName(host) ? "http" : "https"}://${host}/`;
}

function localHostName(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}
