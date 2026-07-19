import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveAccessPolicy } from "../src/domain/project-access.js";

describe("resolveAccessPolicy", () => {
  it("fails clearly when no secret is available non-interactively", async () => {
    const error = await Effect.runPromise(
      resolveAccessPolicy({
        override: { type: "password" },
        interactive: false,
      }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("CliConfigError");
    expect(error.message).toContain("--password <value>");
  });
});
