import { describe, expect, it } from "vitest";

import { renderFailure } from "../src/cli/messages.js";
import { CliConfigError } from "../src/errors.js";

describe("renderFailure", () => {
  it("keeps the originating error in terminal failures", () => {
    const message = renderFailure({
      _tag: "Expected",
      output: { _tag: "Terminal" },
      error: new CliConfigError({ message: "The configured port is invalid." }),
    });

    expect(message).toMatchObject({ _tag: "Text", stream: "stderr" });
    if (message._tag === "Text") {
      expect(message.text).toContain("The configured port is invalid.");
    }
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
