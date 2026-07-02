export type QueueMessage<T> = {
  readonly id: string;
  readonly payload: T;
  readonly ack: () => Promise<void>;
};

export type ReceiveOptions = {
  readonly topic: string;
  readonly consumerGroup: string;
  readonly limit: number;
  readonly visibilityTimeoutSeconds: number;
};

export type SendOptions = {
  readonly idempotencyKey?: string;
  readonly ttlSeconds?: number;
};

export interface Broker {
  send<T>(topic: string, payload: T, options?: SendOptions): Promise<void>;
  receive<T>(options: ReceiveOptions): Promise<Array<QueueMessage<T>>>;
}
