import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";

import type { DeployPlan } from "../domain/deploy-plan.js";
import { GatewayVerificationError } from "../errors.js";

export type GatewayVerifierShape = {
  readonly verify: (plan: DeployPlan) => Effect.Effect<void, GatewayVerificationError>;
};

export class GatewayVerifier extends Context.Service<GatewayVerifier, GatewayVerifierShape>()(
  "turbotunnel/effect/GatewayVerifier",
) {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient;
      return GatewayVerifier.of({
        verify: (plan) => verifyGatewayDeployment(httpClient, plan),
      });
    }),
  );
}

const verificationRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.both(Schedule.recurs(4)),
);

const GatewayStatusJsonSchema = Schema.Struct({
  status: Schema.Literals(["running"]),
  version: Schema.String,
  baseDomain: Schema.String,
  broker: Schema.String,
  queueRegion: Schema.String,
});

type GatewayStatusJson = typeof GatewayStatusJsonSchema.Type;

const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeGatewayStatus = Schema.decodeUnknownEffect(GatewayStatusJsonSchema);

const verifyGatewayDeployment = Effect.fn("GatewayVerifier.verify")(function* (
  httpClient: HttpClient,
  plan: DeployPlan,
): Effect.fn.Return<void, GatewayVerificationError> {
  const gatewayUrl = `https://${plan.publicHost}/`;
  yield* verifyGatewayStatus(httpClient, plan, gatewayUrl).pipe(
    Effect.retry({
      schedule: verificationRetrySchedule,
      while: (error) => error.reason !== "unknown",
    }),
  );
});

const verifyGatewayStatus = Effect.fn("GatewayVerifier.verifyStatus")(function* (
  httpClient: HttpClient,
  plan: DeployPlan,
  baseUrl: string,
): Effect.fn.Return<void, GatewayVerificationError> {
  const statusUrl = yield* Effect.try({
    try: () => new URL("/_turbotunnel/status", baseUrl).toString(),
    catch: (cause) =>
      new GatewayVerificationError({
        reason: "unknown",
        url: baseUrl,
        cause,
        message:
          "Deployment was created, but Turbotunnel could not construct the gateway status URL. Your previous Turbotunnel config is still intact. Check the configured domain and retry `tt deploy`.",
      }),
  });
  const checked = yield* httpClient.get(statusUrl, { accept: "application/json" }).pipe(
    Effect.flatMap((response) => response.text.pipe(Effect.map((body) => ({ response, body })))),
    Effect.mapError(
      (cause) =>
        new GatewayVerificationError({
          reason: "request-failed",
          url: statusUrl,
          cause,
          message:
            "Deployment was created, but Turbotunnel could not reach the gateway status endpoint. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
        }),
    ),
    Effect.timeoutOrElse({
      duration: 15_000,
      orElse: () =>
        Effect.fail(
          new GatewayVerificationError({
            reason: "timeout",
            url: statusUrl,
            message:
              "Deployment was created, but the gateway status endpoint did not respond within 15 seconds. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
          }),
        ),
    }),
  );

  if (checked.response.status !== 200) {
    return yield* new GatewayVerificationError({
      reason: "bad-status",
      url: statusUrl,
      status: checked.response.status,
      message: `Deployment was created, but the public gateway URL returned HTTP ${checked.response.status} during verification. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact.`,
    });
  }

  const json = yield* decodeJsonString(checked.body).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayVerificationError({
          reason: "body-mismatch",
          url: statusUrl,
          cause,
          bodyExcerpt: statusBodyExcerpt(checked.body),
          message: `Deployment was created, but the gateway status endpoint did not return JSON. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact.`,
        }),
    ),
  );
  const status = yield* decodeGatewayStatus(json).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayVerificationError({
          reason: "body-mismatch",
          url: statusUrl,
          cause,
          bodyExcerpt: statusBodyExcerpt(checked.body),
          message: `Deployment was created, but the gateway status JSON had an unsupported shape. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact.`,
        }),
    ),
  );

  yield* assertGatewayStatusField(statusUrl, "version", status.version, TURBOTUNNEL_VERSION);
  yield* assertGatewayStatusField(statusUrl, "baseDomain", status.baseDomain, plan.baseDomain);
  yield* assertGatewayStatusField(statusUrl, "queueRegion", status.queueRegion, plan.queueRegion);
});

function assertGatewayStatusField(
  statusUrl: string,
  field: keyof GatewayStatusJson,
  actual: string,
  expected: string,
): Effect.Effect<void, GatewayVerificationError> {
  if (actual === expected) {
    return Effect.void;
  }

  return new GatewayVerificationError({
    reason: "body-mismatch",
    url: statusUrl,
    bodyExcerpt: `${field}: ${actual}`,
    message: `Deployment was created, but the gateway status JSON did not match the expected ${field}. Expected ${expected}, received ${actual}. Your previous Turbotunnel config is still intact.`,
  });
}

function statusBodyExcerpt(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return "empty response body";
  }

  return firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 160)}...`;
}
