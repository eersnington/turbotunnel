/** Bridges raw Node/ws callbacks into scoped gateway Effect workflows and owned fibers. */
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { LOCAL_CLIENT_SUBPROTOCOL } from "@turbotunnel/contracts";
import { Clock, Effect, FiberSet, Redacted, Schema, Scope } from "effect";
import { WebSocketServer } from "ws";

import { GatewayConfig } from "./gateway-config.js";
import { admitPublicAccess } from "./access.js";
import { hasValidBearerAuth } from "./auth.js";
import { GatewayState } from "./gateway-state.js";
import { parseGatewayRequestHeaders } from "./headers.js";
import { normalizeHost } from "./host.js";
import { runLocalClient, type LocalClientError } from "./local-client.js";
import { OidcTokenAuthority } from "./oidc-token.js";
import { handlePublicHttp } from "./public-http.js";
import { runPublicWebSocket, type PublicWebSocketError } from "./public-websocket.js";
import { Queue } from "./queue.js";
import { PublicRouteRegistry } from "./public-route-registry.js";
import { acquireGatewayWebSocket } from "./websocket.js";

type NodeGatewayRequirements =
  | GatewayConfig
  | GatewayState
  | OidcTokenAuthority
  | PublicRouteRegistry
  | Queue;
type UpgradeError = LocalClientError | PublicWebSocketError;

export class GatewayListenError extends Schema.TaggedErrorClass<GatewayListenError>()(
  "GatewayListenError",
  {
    port: Schema.Number,
    host: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Binds a Node server and removes temporary startup listeners on every exit path. */
export function listenNodeServer(
  server: Server,
  port: number,
  host?: string,
): Effect.Effect<void, GatewayListenError> {
  return Effect.callback((resume) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onListening = (): void => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: NodeJS.ErrnoException): void => {
      cleanup();
      resume(
        Effect.fail(
          new GatewayListenError({
            port,
            ...(host === undefined ? {} : { host }),
            ...(cause.code === undefined ? {} : { code: cause.code }),
            cause,
            message: `Gateway could not listen on ${host === undefined ? "port" : `${host}:`}${port}${cause.code === undefined ? "" : ` (${cause.code})`}. Check whether the address is already in use and retry.`,
          }),
        ),
      );
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (host === undefined) {
      server.listen(port);
    } else {
      server.listen(port, host);
    }
    return Effect.callback<void>((closed) => {
      const onCloseError = (cause?: NodeJS.ErrnoException): void => {
        if (cause !== undefined && cause.code !== "ERR_SERVER_NOT_RUNNING") {
          closed(Effect.die(cause));
        } else {
          closed(Effect.void);
        }
      };
      cleanup();
      server.close(onCloseError);
    });
  });
}

/** Constructs the scoped raw Node HTTP/WebSocket server adapter. */
export const makeNodeGatewayServer = Effect.fn("makeNodeGatewayServer")(
  function* (): Effect.fn.Return<Server, never, NodeGatewayRequirements | Scope.Scope> {
    const config = yield* GatewayConfig;
    const oidcTokenAuthority = yield* OidcTokenAuthority;
    const runServerFiber = yield* FiberSet.makeRuntime<NodeGatewayRequirements, void, never>();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      handleProtocols(protocols) {
        return protocols.has(LOCAL_CLIENT_SUBPROTOCOL) ? LOCAL_CLIENT_SUBPROTOCOL : false;
      },
    });

    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const nodeServer = createServer((request, response) => {
          const fiber = runServerFiber(
            oidcTokenAuthority.accept(request).pipe(
              Effect.andThen(handlePublicHttp(request, response)),
              Effect.catch((error) =>
                Effect.logError("gateway HTTP request failed").pipe(
                  Effect.annotateLogs({ errorTag: error._tag }),
                  Effect.andThen(
                    Effect.sync(() =>
                      writeServiceUnavailable(
                        response,
                        "A gateway dependency operation failed. The local tunnel app was not contacted or did not receive the response.",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          const interruptOnClose = (): void => {
            if (!response.writableEnded) {
              // SAFETY: this callback is the Node boundary; the fiber remains owned by the server FiberSet.
              fiber.interruptUnsafe();
            }
          };
          response.once("close", interruptOnClose);
          fiber.addObserver(() => response.removeListener("close", interruptOnClose));
        });

        nodeServer.on("upgrade", (request, socket, head) => {
          runServerFiber(
            handleUpgrade(webSocketServer, request, socket, head).pipe(
              Effect.catch((error) =>
                Effect.logError("gateway WebSocket connection failed").pipe(
                  Effect.annotateLogs({ errorTag: error._tag }),
                ),
              ),
            ),
          );
        });
        return nodeServer;
      }),
      closeNodeServer,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const client of webSocketServer.clients) {
          client.terminate();
        }
        webSocketServer.close();
      }),
    );
    yield* Effect.logInfo("gateway started").pipe(
      Effect.annotateLogs({ brokerKind: config.brokerKind, queueRegion: config.queueRegion }),
    );
    return server;
  },
);

/** Classifies, authenticates, accepts, and scopes one raw WebSocket upgrade. */
function handleUpgrade(
  webSocketServer: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Effect.Effect<void, UpgradeError, NodeGatewayRequirements> {
  return Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const oidcTokenAuthority = yield* OidcTokenAuthority;
    yield* oidcTokenAuthority.accept(request);
    const routes = yield* PublicRouteRegistry;
    const headersResult = parseGatewayRequestHeaders(request.rawHeaders);
    if (headersResult._tag === "err") {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    const headers = headersResult.value;
    const isLocalClientAttempt = headers.secWebSocketProtocols.includes(LOCAL_CLIENT_SUBPROTOCOL);
    if (
      isLocalClientAttempt &&
      !hasValidBearerAuth(headers.authorization, Redacted.value(config.relaySecret))
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    if (isLocalClientAttempt) {
      yield* Effect.gen(function* () {
        const rawWebSocket = yield* acceptUpgrade(webSocketServer, request, socket, head);
        yield* runLocalClient(yield* acquireGatewayWebSocket(rawWebSocket), headers);
      }).pipe(Effect.scoped);
      return;
    }

    if (headers.secWebSocketProtocols.length > 0) {
      rejectUpgrade(socket, 400, "WebSocket Subprotocols Not Supported");
      return;
    }

    const host = normalizeHost(headers.host);
    if (host === undefined) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const route = yield* routes.lookup(host);
    if (route._tag !== "Found") {
      rejectUpgrade(
        socket,
        route._tag === "Missing" ? 404 : 503,
        route._tag === "Missing" ? "Not Found" : "Service Unavailable",
      );
      return;
    }
    const accessNowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (!admitPublicAccess(route.route.accessPolicy, host, headers, config, accessNowSeconds)) {
      rejectUpgrade(
        socket,
        route.route.accessPolicy.type === "password" ? 401 : 403,
        route.route.accessPolicy.type === "password" ? "Unauthorized" : "Forbidden",
      );
      return;
    }
    yield* Effect.gen(function* () {
      const rawWebSocket = yield* acceptUpgrade(webSocketServer, request, socket, head);
      const gatewayWebSocket = yield* acquireGatewayWebSocket(rawWebSocket);
      yield* runPublicWebSocket(gatewayWebSocket, request, route.route).pipe(
        Effect.catch((error) =>
          Effect.logError("public WebSocket handling failed").pipe(
            Effect.annotateLogs({ errorTag: error._tag }),
            Effect.andThen(gatewayWebSocket.close(1011, "gateway queue operation failed")),
          ),
        ),
      );
    }).pipe(Effect.scoped);
  });
}

/** Converts `handleUpgrade` callback completion and interruption into an Effect. */
function acceptUpgrade(
  webSocketServer: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  return Effect.callback<import("ws").WebSocket>((resume) => {
    const onClose = (): void => resume(Effect.interrupt);
    socket.once("close", onClose);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socket.removeListener("close", onClose);
      resume(Effect.succeed(webSocket));
    });
    return Effect.sync(() => {
      socket.removeListener("close", onClose);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  });
}

/** Waits for an actively listening Node server to close. */
function closeNodeServer(server: Server): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });
}

/** Writes the gateway's minimal HTTP upgrade rejection before destroying the socket. */
function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Translates an unhandled dependency failure into the established HTTP response. */
function writeServiceUnavailable(
  response: import("node:http").ServerResponse,
  message: string,
): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}
