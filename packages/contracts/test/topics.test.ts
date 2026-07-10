import { describe, expect, test } from "vitest";

import {
  httpResponseConsumerGroup,
  httpResponseTopic,
  localConsumerGroup,
  requestTopic,
  wsBrowserOutConsumerGroup,
  wsBrowserOutTopic,
  wsLocalInConsumerGroup,
  wsLocalInTopic,
} from "../src/index.js";

describe("queue topic names", () => {
  test("formats HTTP tunnel topics", () => {
    expect(requestTopic("demo")).toBe("tt_req_demo");
    expect(localConsumerGroup("demo")).toBe("tt_local_demo");
    expect(httpResponseTopic("req_1")).toBe("tt_res_req_1");
    expect(httpResponseConsumerGroup("req_1")).toBe("tt_wait_req_1");
  });

  test("formats WebSocket tunnel topics", () => {
    expect(wsBrowserOutTopic("conn_1")).toBe("tt_wsout_conn_1");
    expect(wsBrowserOutConsumerGroup("conn_1")).toBe("tt_ws_wait_conn_1");
    expect(wsLocalInTopic("conn_1")).toBe("tt_wsin_conn_1");
    expect(wsLocalInConsumerGroup("conn_1")).toBe("tt_wsin_local_conn_1");
  });
});
