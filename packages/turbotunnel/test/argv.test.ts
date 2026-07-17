import { prepareCliArgv } from "../src/cli/argv.js";
import { describe, expect, it } from "vitest";

describe("prepareCliArgv password normalization", () => {
  it("normalizes bare, valued, and next-flag --password forms", () => {
    expect(prepareCliArgv(["http", "1024", "--password"])).toEqual(["http", "1024", "--password="]);
    expect(prepareCliArgv(["http", "1024", "--password=secret"])).toEqual([
      "http",
      "1024",
      "--password=secret",
    ]);
    expect(prepareCliArgv(["http", "1024", "--password", "secret"])).toEqual([
      "http",
      "1024",
      "--password=secret",
    ]);
    expect(prepareCliArgv(["http", "1024", "--password", "--public"])).toEqual([
      "http",
      "1024",
      "--password=",
      "--public",
    ]);
  });

  it("stops at -- so child --password is not consumed", () => {
    expect(prepareCliArgv(["dev", "--password", "--", "vite", "--password", "x"])).toEqual([
      "dev",
      "--password=",
      "\0turbotunnel-dev:vite",
      "\0turbotunnel-dev:--password",
      "\0turbotunnel-dev:x",
    ]);
  });
});
