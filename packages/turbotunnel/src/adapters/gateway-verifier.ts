import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Context, Effect, Layer, Redacted, Schedule } from "effect";
import { HttpClient } from "effect/unstable/http/HttpClient";

import type { DeployPlan } from "../domain/deploy-plan.js";
import { GatewayVerificationError } from "../errors.js";
import {
  decodeGatewayStatusResponse,
  type GatewayRunningStatus,
} from "./gateway-status-checker.js";

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

const verifyGatewayDeployment = Effect.fn("GatewayVerifier.verify")(function* (
  httpClient: HttpClient,
  plan: DeployPlan,
): Effect.fn.Return<void, GatewayVerificationError> {
  const gatewayUrl = `https://${plan.publicHost}/`;
  yield* verifyGatewayStatus(httpClient, plan, gatewayUrl).pipe(
    Effect.retry({
      schedule: verificationRetrySchedule,
      while: isTransientVerificationError,
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
  yield* httpClient
    .get(statusUrl, {
      accept: "application/json",
      headers: { authorization: `Bearer ${Redacted.value(plan.relaySecret)}` },
    })
    .pipe(
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
      Effect.flatMap((response) => {
        if (response.status !== 200) {
          return new GatewayVerificationError({
            reason: "bad-status",
            url: statusUrl,
            status: response.status,
            message: `Deployment was created, but the public gateway URL returned HTTP ${response.status} during verification. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact.`,
          });
        }
        return decodeGatewayStatusResponse(response).pipe(
          Effect.mapError(
            (cause) =>
              new GatewayVerificationError({
                reason: "body-mismatch",
                url: statusUrl,
                cause,
                message: `Deployment was created, but the gateway status endpoint returned an invalid or oversized response. Checked: ${statusUrl}. Your previous Turbotunnel config is still intact.`,
              }),
          ),
          Effect.flatMap((status) =>
            Effect.gen(function* () {
              yield* assertGatewayStatusField(
                statusUrl,
                "version",
                status.version,
                TURBOTUNNEL_VERSION,
              );
              yield* assertGatewayStatusField(
                statusUrl,
                "baseDomain",
                status.baseDomain,
                plan.baseDomain,
              );
              yield* assertGatewayStatusField(
                statusUrl,
                "queueRegion",
                status.queueRegion,
                plan.queueRegion,
              );
            }),
          ),
        );
      }),
      Effect.timeoutOrElse({
        duration: 15_000,
        orElse: () =>
          Effect.fail(
            new GatewayVerificationError({
              reason: "timeout",
              url: statusUrl,
              message:
                "Deployment was created, but the gateway status endpoint did not complete within 15 seconds. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
            }),
          ),
      }),
    );
});

function isTransientVerificationError(error: GatewayVerificationError): boolean {
  if (error.reason === "request-failed" || error.reason === "timeout") return true;
  return (
    error.reason === "bad-status" &&
    error.status !== undefined &&
    [404, 408, 429, 500, 502, 503, 504].includes(error.status)
  );
}

function assertGatewayStatusField(
  statusUrl: string,
  field: keyof GatewayRunningStatus,
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
