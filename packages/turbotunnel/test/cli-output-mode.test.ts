import { describe, expect, it } from "vitest";

import { requestedOutput } from "../src/cli/commands.js";

describe("requestedOutput", () => {
  it("detects JSON only for commands that own the format flag", () => {
    expect(requestedOutput(["node", "tt", "list", "--format", "json"])).toEqual({
      _tag: "Json",
    });
    expect(requestedOutput(["node", "tt", "dev", "--", "tool", "--format", "json"])).toEqual({
      _tag: "Terminal",
    });
  });
});
