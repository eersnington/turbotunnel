import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveAccessPolicy } from "../src/domain/project-access.js";

describe("resolveAccessPolicy", () => {
  it("uses the generated password when password access has no explicit value", async () => {
    const access = await Effect.runPromise(
      resolveAccessPolicy({
        configured: { type: "password" },
        generatedPassword: "tt_generated",
      }),
    );

    expect(access.password).toBe("tt_generated");
    expect(access.policy.type).toBe("password");
    if (access.policy.type === "password") {
      expect(access.policy.hash).not.toContain("tt_generated");
    }
  });

  it("uses an explicit password override", async () => {
    const access = await Effect.runPromise(
      resolveAccessPolicy({
        override: { type: "password", password: "chosen-password" },
        generatedPassword: "tt_generated",
      }),
    );

    expect(access.password).toBe("chosen-password");
    expect(access.policy.type).toBe("password");
  });
});
