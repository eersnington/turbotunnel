import { describe, expect, it } from "vitest";

import { formatProcessCommand } from "../src/domain/process-command.js";

describe("formatProcessCommand", () => {
  it("keeps simple arguments readable and quotes whitespace", () => {
    expect(formatProcessCommand("pnpm", ["run", "dev", "--host", "localhost"])).toBe(
      "pnpm run dev --host localhost",
    );
    expect(formatProcessCommand("node", ["-e", "console.log('ready')"])).toBe(
      `node -e ${JSON.stringify("console.log('ready')")}`,
    );
  });

  it("escapes terminal control characters", () => {
    const command = formatProcessCommand("node", ["\u001B[2J\u009B31m\nsecret"]);
    expect(command).not.toContain("\u001B");
    expect(command).not.toContain("\u009B");
    expect(command).not.toContain("\n");
    expect(command).toContain("\\\\u001b[2J\\\\u009b31m\\\\u000asecret");
  });

  it("redacts common secret arguments", () => {
    expect(
      formatProcessCommand("server", [
        "--token",
        "secret-token",
        "--api-key",
        "api-key",
        "--password=hunter2",
        "--client-secret=client-secret",
        "API_KEY=secret-key",
      ]),
    ).toBe(
      "server --token <redacted> --api-key <redacted> --password=<redacted> --client-secret=<redacted> API_KEY=<redacted>",
    );
  });
});
