import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { AppPaths } from "../src/adapters/app-paths.js";
import { Entropy } from "../src/adapters/entropy.js";
import { GatewayVerifier } from "../src/adapters/gateway-verifier.js";
import { GatewayWorkspace } from "../src/adapters/gateway-workspace.js";
import { LocalConfigStore, type LocalConfig } from "../src/adapters/local-config-store.js";
import { VercelCli } from "../src/adapters/vercel-cli.js";
import { CliOutput, type CliMessage } from "../src/cli/output.js";
import { TerminalSurface } from "../src/cli/terminal-surface.js";
import type { SavedDeployConfig } from "../src/domain/deploy-plan.js";
import { GatewayVerificationError, VercelCliFailed } from "../src/errors.js";
import { deployGateway } from "../src/programs/deploy-gateway.js";

describe("deployGateway", () => {
  it.effect("deploys, verifies, then writes config through service seams", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder();

      yield* deployGateway({ output: { _tag: "Terminal" } }).pipe(Effect.provide(recorder.layer()));

      expect(recorder.workspaceGenerated?.endsWith("/.turbotunnel/relay")).toBe(true);
      expect(recorder.vercelOperations).toEqual([
        "requireInstalled",
        "currentAccount",
        "link:ttabc123-turbotunnel",
        "env:TURBOTUNNEL_BASE_DOMAIN={slug}-turbotunnel.vercel.app",
        "env:TURBOTUNNEL_RELAY_SECRET=ttsec_test",
        "env:TURBOTUNNEL_QUEUE_REGION=iad1",
        "deploy",
      ]);
      expect(recorder.verifiedHost).toBe("ttabc123-turbotunnel.vercel.app");
      expect(recorder.writtenConfig).toMatchObject({
        project: "ttabc123-turbotunnel",
        slug: "ttabc123",
        relayDomain: "{slug}-turbotunnel.vercel.app",
        relaySecret: "ttsec_test",
        queueRegion: "iad1",
      });
      expect(recorder.terminalWrites.join("\n")).toMatch(
        /Gateway[\s\S]*deployed|deployed[\s\S]*Gateway/,
      );
      expect(recorder.terminalWrites.join("\n")).not.toContain("\u001B");
    }),
  );

  it.effect("reuses a saved deploy target and secret when flags do not override it", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder({
        project: "demo-turbotunnel",
        slug: "demo",
        relayDomain: "tunnel.example.com",
        relaySecret: "saved_secret",
        queueRegion: "sfo1",
      });

      yield* deployGateway({ output: { _tag: "Terminal" } }).pipe(Effect.provide(recorder.layer()));

      expect(recorder.vercelOperations).toContain("env:TURBOTUNNEL_RELAY_SECRET=saved_secret");
      expect(recorder.writtenConfig).toMatchObject({
        project: "demo-turbotunnel",
        slug: "demo",
        relayDomain: "tunnel.example.com",
        queueRegion: "sfo1",
      });
    }),
  );

  it.effect("writes deploy summary as json when requested", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder();

      yield* deployGateway({ output: { _tag: "Json" } }).pipe(Effect.provide(recorder.layer()));

      expect(recorder.outputMessages).toContainEqual({
        _tag: "Json",
        stream: "stdout",
        value: expect.objectContaining({ reason: "gateway_deployed" }),
      });
    }),
  );

  it.effect("adds a custom wildcard domain before deploying", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder();

      yield* deployGateway({ output: { _tag: "Terminal" }, domain: "tunnel.example.com" }).pipe(
        Effect.provide(recorder.layer()),
      );

      expect(recorder.vercelOperations).toContain("domain:*.tunnel.example.com");
      expect(recorder.vercelOperations.indexOf("domain:*.tunnel.example.com")).toBeLessThan(
        recorder.vercelOperations.indexOf("deploy"),
      );
    }),
  );

  it.effect("does not write config when Vercel deployment fails", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder();
      recorder.failDeploy = true;

      const exit = yield* deployGateway({ output: { _tag: "Terminal" } }).pipe(
        Effect.provide(recorder.layer()),
        Effect.exit,
      );

      expect(exit._tag).toBe("Failure");
      expect(recorder.writtenConfig).toBeUndefined();
    }),
  );

  it.effect("does not write config when gateway verification fails", () =>
    Effect.gen(function* () {
      const recorder = new DeployRecorder();
      recorder.failVerification = true;

      const exit = yield* deployGateway({ output: { _tag: "Terminal" } }).pipe(
        Effect.provide(recorder.layer()),
        Effect.exit,
      );

      expect(exit._tag).toBe("Failure");
      expect(recorder.writtenConfig).toBeUndefined();
    }),
  );
});

class DeployRecorder {
  readonly vercelOperations: Array<string> = [];
  readonly outputMessages: Array<CliMessage> = [];
  readonly terminalWrites: Array<string> = [];
  workspaceGenerated: string | undefined;
  verifiedHost: string | undefined;
  writtenConfig: Required<SavedDeployConfig> | undefined;
  failDeploy = false;
  failVerification = false;

  constructor(private readonly savedConfig: LocalConfig = {}) {}

  layer() {
    return Layer.mergeAll(
      Layer.succeed(
        AppPaths,
        AppPaths.of({
          configPath: "/tmp/.turbotunnel/config.json",
          deployDir: "/tmp/.turbotunnel/relay",
          runtimeDir: "/tmp/.turbotunnel/runtime",
        }),
      ),
      Layer.succeed(
        Entropy,
        Entropy.of({
          deploySlug: Effect.succeed("ttabc123"),
          tunnelSlug: Effect.succeed("local1"),
          relaySecret: Effect.succeed(Redacted.make("ttsec_test", { label: "relay-secret" })),
        }),
      ),
      Layer.succeed(
        LocalConfigStore,
        LocalConfigStore.of({
          read: Effect.succeed(this.savedConfig),
          write: (config) =>
            Effect.sync(() => {
              this.writtenConfig = config;
            }),
        }),
      ),
      Layer.succeed(
        VercelCli,
        VercelCli.of({
          requireInstalled: Effect.sync(() => this.vercelOperations.push("requireInstalled")),
          currentAccount: Effect.sync(() => {
            this.vercelOperations.push("currentAccount");
            return "vercel-user";
          }),
          linkProject: (_cwd, project) =>
            Effect.sync(() => this.vercelOperations.push(`link:${project}`)),
          setProductionEnv: (_cwd, name, value) =>
            Effect.sync(() => this.vercelOperations.push(`env:${name}=${envValue(value)}`)),
          addDomain: (_cwd, domain) =>
            Effect.sync(() => this.vercelOperations.push(`domain:${domain}`)),
          deployProduction: () =>
            this.failDeploy
              ? Effect.fail(
                  new VercelCliFailed({
                    command: "vercel deploy --prod --yes",
                    failure: { _tag: "NonZeroExit", exitCode: 1 },
                    message: "deploy failed",
                  }),
                )
              : Effect.sync(() => {
                  this.vercelOperations.push("deploy");
                  return "https://deployment.example.com/";
                }),
        }),
      ),
      Layer.succeed(
        GatewayWorkspace,
        GatewayWorkspace.of({
          copyTo: (deployDir) =>
            Effect.sync(() => {
              this.workspaceGenerated = deployDir;
            }),
        }),
      ),
      Layer.succeed(
        GatewayVerifier,
        GatewayVerifier.of({
          verify: (plan) =>
            this.failVerification
              ? Effect.fail(
                  new GatewayVerificationError({
                    reason: "bad-status",
                    url: `https://${plan.publicHost}/_turbotunnel/status`,
                    status: 500,
                    message: "verification failed",
                  }),
                )
              : Effect.sync(() => {
                  this.verifiedHost = plan.publicHost;
                }),
        }),
      ),
      Layer.succeed(
        CliOutput,
        CliOutput.of({
          write: (message) =>
            Effect.sync(() => {
              this.outputMessages.push(message);
            }),
        }),
      ),
      TerminalSurface.layer({
        capabilities: { interactive: false, color: false },
        write: (text) => Effect.sync(() => this.terminalWrites.push(text)),
      }),
    );
  }
}

function envValue(value: string | Redacted.Redacted<string>): string {
  return typeof value === "string" ? value : Redacted.value(value);
}
