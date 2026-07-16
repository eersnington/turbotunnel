import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { customCommandPort, type DevProject, resolveDevLaunch } from "../src/domain/dev-project.js";

describe("dev project launch resolution", () => {
  it.effect("uses the package manager dev script and Vite strict port adapter", () =>
    Effect.gen(function* () {
      const launch = yield* resolveDevLaunch(
        project({ packageManager: "pnpm" }),
        {
          command: [],
        },
        5173,
      );

      expect(launch).toMatchObject({
        executable: "pnpm",
        args: ["run", "dev", "--port", "5173", "--strictPort"],
      });
    }),
  );

  it.effect("runs custom argv directly and normalizes a recognized framework port", () =>
    Effect.gen(function* () {
      const launch = yield* resolveDevLaunch(
        project(),
        { command: ["vite", "--host", "0.0.0.0", "--port=4173"] },
        5173,
      );

      expect(launch.executable).toBe("vite");
      expect(launch.args).toEqual(["--host", "0.0.0.0", "--port", "5173", "--strictPort"]);
    }),
  );

  it.effect("uses each package manager's argument forwarding convention", () =>
    Effect.gen(function* () {
      const expected = {
        npm: ["run", "dev", "--", "--port", "5173", "--strictPort"],
        pnpm: ["run", "dev", "--port", "5173", "--strictPort"],
        yarn: ["run", "dev", "--port", "5173", "--strictPort"],
        bun: ["run", "dev", "--port", "5173", "--strictPort"],
      } as const;

      for (const packageManager of ["npm", "pnpm", "yarn", "bun"] as const) {
        const launch = yield* resolveDevLaunch(project({ packageManager }), { command: [] }, 5173);
        expect(launch.args).toEqual(expected[packageManager]);
      }
    }),
  );

  it.effect("applies each explicit custom framework adapter", () =>
    Effect.gen(function* () {
      const cases = [
        { command: ["next", "dev"], args: ["dev", "-p", "5173"] },
        { command: ["astro", "dev"], args: ["dev", "--port", "5173"] },
        { command: ["nuxt", "dev"], args: ["dev", "--port", "5173"] },
        { command: ["storybook", "dev"], args: ["dev", "--port", "5173"] },
      ];
      for (const testCase of cases) {
        const launch = yield* resolveDevLaunch(project(), { command: testCase.command }, 5173);
        expect(launch.args).toEqual(testCase.args);
      }
    }),
  );

  it.effect("recognizes custom Next and Vite port arguments", () =>
    Effect.gen(function* () {
      expect(yield* customCommandPort(["next", "dev", "-p", "4000"])).toBe(4000);
      expect(yield* customCommandPort(["vite", "--port=4173"])).toBe(4173);
      expect(yield* customCommandPort(["node", "server.js", "--port", "3000"])).toBe(3000);
      expect(yield* customCommandPort(["node", "server.js", "-p", "3000"])).toBeUndefined();
    }),
  );

  it.effect("lets an explicit port replace a generic custom command port", () =>
    Effect.gen(function* () {
      const launch = yield* resolveDevLaunch(
        project(),
        { port: 5173, command: ["node", "server.js", "--port=3000", "--watch"] },
        5173,
      );
      expect(launch.args).toEqual(["server.js", "--watch", "--port", "5173"]);
    }),
  );

  it.effect("does not infer a framework when the dev script does not name one", () =>
    Effect.gen(function* () {
      const launch = yield* resolveDevLaunch(
        project({ scripts: { dev: "node server.js" } }),
        { command: [] },
        5173,
      );
      expect(launch.args).toEqual(["run", "dev"]);
    }),
  );

  it.effect("rejects an invalid recognized custom command port", () =>
    Effect.gen(function* () {
      const error = yield* customCommandPort(["vite", "--port", "nope"]).pipe(Effect.flip);
      expect(error._tag).toBe("CliConfigError");
    }),
  );

  it.effect("rejects a missing default dev script", () =>
    Effect.gen(function* () {
      const error = yield* resolveDevLaunch(project({ scripts: {} }), { command: [] }, 5173).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("DevScriptNotFound");
    }),
  );
});

function project(overrides: Partial<DevProject> = {}): DevProject {
  return {
    root: "/project",
    packageJsonPath: "/project/package.json",
    packageManager: "npm",
    scripts: { dev: "vite" },
    ...overrides,
  };
}
