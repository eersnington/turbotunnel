import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { LocalConfigStore, type LocalConfig } from "../src/adapters/local-config-store.js";
import { ProjectDomain } from "../src/adapters/project-domain.js";
import { VercelCli } from "../src/adapters/vercel-cli.js";
import { VercelCliFailed } from "../src/errors.js";

describe("ProjectDomain", () => {
  it.effect("uses the generated exact fallback when the requested slug is taken", () =>
    Effect.gen(function* () {
      const added: Array<string> = [];
      let written: LocalConfig | undefined;
      const layer = ProjectDomain.live.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(
              LocalConfigStore,
              LocalConfigStore.of({
                read: Effect.succeed({ project: "gateway" }),
                write: (config) =>
                  Effect.sync(() => {
                    written = config;
                  }),
              }),
            ),
            Layer.succeed(
              VercelCli,
              VercelCli.of({
                requireInstalled: Effect.void,
                currentAccount: Effect.succeed("demo"),
                linkProject: () => Effect.void,
                setProductionEnv: () => Effect.void,
                apiGet: (path) =>
                  Effect.succeed(
                    path.includes("/domains")
                      ? { domains: [] }
                      : { id: "prj_123", name: "gateway", accountId: "team_123" },
                  ),
                addDomain: (_cwd, domain) => {
                  added.push(domain);
                  return domain === "dashboard-turbotunnel.vercel.app"
                    ? Effect.fail(
                        new VercelCliFailed({
                          command: "vercel domains add",
                          failure: { _tag: "NonZeroExit", exitCode: 1 },
                          message: "Domain name conflict: already assigned to another project",
                        }),
                      )
                    : Effect.void;
                },
                verifyDomain: () => Effect.void,
                deployProduction: () => Effect.succeed("https://deployment.example.com/"),
              }),
            ),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        return yield* (yield* ProjectDomain).reconcile({
          configIdentity: "/repo/turbotunnel.json",
          targetName: "dashboard",
          targetPath: "/repo/apps/dashboard",
          requestedSlug: "dashboard",
          gateway: { project: "gateway" },
          generatedDeploySlug: "ttabc123",
        });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({
        slug: "ttabc123-dashboard",
        domain: "ttabc123-dashboard.vercel.app",
      });
      expect(added).toEqual(["dashboard-turbotunnel.vercel.app", "ttabc123-dashboard.vercel.app"]);
      expect(written).toMatchObject({
        teamId: "team_123",
        projectId: "prj_123",
        domainAssignments: [
          {
            configIdentity: "/repo/turbotunnel.json",
            targetName: "dashboard",
            targetPath: "/repo/apps/dashboard",
            ...result,
          },
        ],
      });
    }),
  );
});
