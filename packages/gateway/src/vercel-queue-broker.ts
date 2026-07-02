import { Buffer } from "node:buffer";

import type { Broker, QueueMessage, ReceiveOptions, SendOptions } from "./broker.js";

type NdjsonQueueMessage = {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
};

export class VercelQueueBroker implements Broker {
  constructor(
    private readonly region: string,
    // In Vercel Functions the OIDC token arrives on each request as
    // x-vercel-oidc-token. It is not a stable runtime env var, so the gateway
    // captures the latest request token and passes it in here.
    private readonly getOidcToken: () => string | undefined = () => process.env.VERCEL_OIDC_TOKEN,
  ) {}

  async send<T>(topic: string, payload: T, options: SendOptions = {}): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/topic/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "content-type": "application/json",
        ...(options.ttlSeconds === undefined
          ? {}
          : { "vqs-retention-seconds": String(options.ttlSeconds) }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { "vqs-idempotency-key": options.idempotencyKey }),
      },
      body: JSON.stringify(payload),
    });

    if (response.status !== 201 && response.status !== 202) {
      throw new Error(`Vercel Queue send failed with status ${response.status}`);
    }
  }

  async receive<T>(options: ReceiveOptions): Promise<Array<QueueMessage<T>>> {
    const url = `${this.baseUrl()}/topic/${encodeURIComponent(options.topic)}/consumer/${encodeURIComponent(options.consumerGroup)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        accept: "application/x-ndjson",
        "vqs-max-messages": String(options.limit),
        "vqs-visibility-timeout-seconds": String(options.visibilityTimeoutSeconds),
      },
    });

    if (response.status === 204) {
      return [];
    }

    if (response.status !== 200) {
      throw new Error(`Vercel Queue receive failed with status ${response.status}`);
    }

    const text = await response.text();
    const messages = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NdjsonQueueMessage);

    return messages.map((message) => ({
      id: message.messageId,
      payload: JSON.parse(Buffer.from(message.body, "base64").toString("utf8")) as T,
      ack: async () => {
        await this.ack(options.topic, options.consumerGroup, message.receiptHandle);
      },
    }));
  }

  private async ack(topic: string, consumerGroup: string, receiptHandle: string): Promise<void> {
    const url = `${this.baseUrl()}/topic/${encodeURIComponent(topic)}/consumer/${encodeURIComponent(consumerGroup)}/lease/${encodeURIComponent(receiptHandle)}`;
    const response = await fetch(url, { method: "DELETE", headers: this.authHeaders() });
    if (response.status !== 204 && response.status !== 404 && response.status !== 409) {
      throw new Error(`Vercel Queue ack failed with status ${response.status}`);
    }
  }

  private baseUrl(): string {
    return `https://${this.region}.vercel-queue.com/api/v3`;
  }

  private authHeaders(): Record<string, string> {
    const token = this.getOidcToken();
    if (token === undefined || token.length === 0) {
      throw new Error(
        "Vercel Queue API requires an OIDC token, but this gateway instance has not received one yet. Retry after the tunnel reconnects; if this continues, enable Vercel OIDC for the project.",
      );
    }

    return { authorization: `Bearer ${token}` };
  }
}
