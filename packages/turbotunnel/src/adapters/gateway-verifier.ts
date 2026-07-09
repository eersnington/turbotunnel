import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import type { DeployPlan } from "../domain/deploy-plan.js";
import { GatewayVerificationError } from "../errors.js";

export type GatewayVerifierShape = {
  readonly verify: (plan: DeployPlan) => Effect.Effect<void, GatewayVerificationError>;
};

export class GatewayVerifier extends Context.Service<GatewayVerifier, GatewayVerifierShape>()(
  "turbotunnel/effect/GatewayVerifier",
) {
  static readonly live = Layer.succeed(this, this.of({ verify: verifyGatewayDeployment }));
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

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

function verifyGatewayDeployment(plan: DeployPlan): Effect.Effect<void, GatewayVerificationError> {
  return Effect.gen(function* () {
    const gatewayUrl = `https://${plan.publicHost}/`;
    let latestError: GatewayVerificationError | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const error = yield* verifyGatewayStatus(plan, gatewayUrl).pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      );
      if (error === undefined) {
        return;
      }

      latestError = error;
      const retryDelayMs = RETRY_DELAYS_MS[attempt];
      if (retryDelayMs !== undefined) {
        yield* Effect.sleep(retryDelayMs);
      }
    }

    return yield* (
      latestError ??
        new GatewayVerificationError({
          reason: "unknown",
          url: gatewayUrl,
          message:
            "Deployment was created, but Turbotunnel could not verify the public gateway URL. Your previous Turbotunnel config is still intact. Retry `tt deploy`, or open the Vercel deployment logs if this continues.",
        })
    );
  });
}

function verifyGatewayStatus(
  plan: DeployPlan,
  baseUrl: string,
): Effect.Effect<void, GatewayVerificationError> {
  return Effect.gen(function* () {
    const statusUrl = new URL("/_turbotunnel/status", baseUrl).toString();
    const checked = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await globalThis.fetch(statusUrl, {
          headers: { accept: "application/json" },
          signal,
        });
        const body = await response.text();
        return { response, body };
      },
      catch: (cause) =>
        new GatewayVerificationError({
          reason: "request-failed",
          url: statusUrl,
          cause,
          message:
            "Deployment was created, but Turbotunnel could not reach the gateway status endpoint. Local config was not changed. Open the Vercel deployment logs and retry `tt deploy` after fixing the deployment.",
        }),
    }).pipe(
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
}

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
