/** Bridges raw Node/ws callbacks into scoped gateway Effect workflows and owned fibers. */
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { LOCAL_CLIENT_SUBPROTOCOL } from "@turbotunnel/contracts";
import { Effect, FiberSet, Redacted, Scope } from "effect";
import { WebSocketServer } from "ws";

import { GatewayConfig } from "./gateway-config.js";
import { admitPublicAccess } from "./access.js";
import { hasValidBearerAuth } from "./auth.js";
import { GatewayState } from "./gateway-state.js";
import { parseGatewayRequestHeaders } from "./headers.js";
import { normalizeHost } from "./host.js";
import { runLocalClient, type LocalClientError } from "./local-client.js";
import { OidcToken } from "./oidc-token.js";
import { handlePublicHttp } from "./public-http.js";
import { runPublicWebSocket, type PublicWebSocketError } from "./public-websocket.js";
import { Queue } from "./queue.js";
import { PublicRouteRegistry } from "./public-route-registry.js";
import { acquireGatewayWebSocket } from "./websocket.js";

type NodeGatewayRequirements =
  | GatewayConfig
  | GatewayState
  | OidcToken
  | PublicRouteRegistry
  | Queue;
type UpgradeError = LocalClientError | PublicWebSocketError;

/** Constructs the scoped raw Node HTTP/WebSocket server adapter. */
export const makeNodeGatewayServer = Effect.fn("makeNodeGatewayServer")(
  function* (): Effect.fn.Return<Server, never, NodeGatewayRequirements | Scope.Scope> {
    const config = yield* GatewayConfig;
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
            handlePublicHttp(request, response).pipe(
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
    const oidcToken = yield* OidcToken;
    const routes = yield* PublicRouteRegistry;
    const headersResult = parseGatewayRequestHeaders(request.rawHeaders);
    if (headersResult._tag === "err") {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    const headers = headersResult.value;
    if (headers.oidcToken !== undefined) {
      yield* oidcToken.set(headers.oidcToken);
    }
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
    if (!(yield* admitPublicAccess(route.route.accessPolicy, host, headers, config))) {
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
