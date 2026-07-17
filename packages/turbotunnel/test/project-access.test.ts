import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveAccessPolicy } from "../src/domain/project-access.js";

describe("resolveAccessPolicy", () => {
  it("prefers an inline --password value over the environment", async () => {
    const inline = await Effect.runPromise(
      resolveAccessPolicy({
        override: { type: "password", password: "inline-secret" },
        password: "env-secret",
        interactive: false,
      }),
    );
    const fromEnv = await Effect.runPromise(
      resolveAccessPolicy({
        override: { type: "password" },
        password: "env-secret",
        interactive: false,
      }),
    );
    expect(inline).toMatchObject({ type: "password" });
    expect(fromEnv).toMatchObject({ type: "password" });
    if (inline.type !== "password" || fromEnv.type !== "password") return;
    expect(inline.hash).toMatch(/^scrypt\$1\$/);
    expect(fromEnv.hash).toMatch(/^scrypt\$1\$/);
    expect(inline.hash).not.toBe(fromEnv.hash);
  });

  it("fails clearly when no secret is available non-interactively", async () => {
    const error = await Effect.runPromise(
      resolveAccessPolicy({
        override: { type: "password" },
        interactive: false,
      }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("CliConfigError");
    expect(error.message).toContain("TURBOTUNNEL_PASSWORD");
  });
});
