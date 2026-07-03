export const PROTOCOL_VERSION = 1;

export const LOCAL_CLIENT_SUBPROTOCOL = "turbotunnel-local-client-v1";

export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_CONCURRENT_HTTP_REQUESTS_PER_TUNNEL = 32;
export const MAX_PUBLIC_WEBSOCKETS_PER_TUNNEL = 32;
export const DEFAULT_LOCAL_CLIENT_POOL_SIZE = 2;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const LOCAL_CLIENT_CAPACITY = 32;

export const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 15;
export const QUEUE_REQUEST_TTL_SECONDS = 60;
export const QUEUE_RESPONSE_TTL_SECONDS = 60;
export const QUEUE_RECEIVE_LIMIT = 10;
export const QUEUE_RECEIVE_HOT_DELAY_MS = 100;
export const QUEUE_RECEIVE_WARM_DELAY_MS = 1_000;
export const QUEUE_RECEIVE_COLD_DELAY_MS = 5_000;
export const QUEUE_RECEIVE_COLD_AFTER_EMPTY = 5;

export const LOCAL_CLIENT_ACK_TIMEOUT_MS = 1_000;
export const PUBLIC_HTTP_TIMEOUT_MS = 30_000;

export function requestTopic(slug: string): string {
  return `tt_req_${slug}`;
}

export function localConsumerGroup(slug: string): string {
  return `tt_local_${slug}`;
}

export function httpResponseTopic(requestId: string): string {
  return `tt_res_${requestId}`;
}

export function httpResponseConsumerGroup(requestId: string): string {
  return `tt_wait_${requestId}`;
}

export function wsBrowserOutTopic(connId: string): string {
  return `tt_wsout_${connId}`;
}

export function wsBrowserOutConsumerGroup(connId: string): string {
  return `tt_ws_wait_${connId}`;
}

export function wsLocalInTopic(connId: string): string {
  return `tt_wsin_${connId}`;
}

export function wsLocalInConsumerGroup(connId: string): string {
  return `tt_wsin_local_${connId}`;
}
