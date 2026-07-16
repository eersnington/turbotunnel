import { describe, expect, it } from "vitest";

import { renderFailure } from "../src/cli/messages.js";
import { CliConfigError } from "../src/errors.js";

describe("renderFailure", () => {
  it("renders actionable terminal recovery details", () => {
    const message = renderFailure({
      _tag: "Expected",
      output: { _tag: "Terminal" },
      error: new CliConfigError({ message: "Port must be an integer from 1 to 65535." }),
    });

    expect(message).toMatchObject({ _tag: "Text", stream: "stderr" });
    if (message._tag !== "Text") return;
    expect(message.text).toContain("Port must be an integer from 1 to 65535.");
    expect(message.text).toContain("Attempted");
    expect(message.text).toContain("Preserved");
    expect(message.text).toContain("Next");
  });

  it("keeps JSON failures free of terminal presentation", () => {
    expect(
      renderFailure({
        _tag: "Expected",
        output: { _tag: "Json" },
        error: new CliConfigError({ message: "Format must be `json`." }),
      }),
    ).toEqual({
      _tag: "Json",
      stream: "stdout",
      value: {
        status: "error",
        reason: "CliConfigError",
        message: "Format must be `json`.",
      },
    });
  });
});
