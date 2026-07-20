# turbotunnel

## 0.1.0

### Minor Changes

- 2a67824: Make tt dev open configured project tunnels and optionally run an exact child command.
- 8357e78: Add project-aware tunnel configuration, managed domains, access controls, and offline app recovery with Vercel CLI.
- 7a8b87d: Add managed `dev`, local `status`, and gateway-wide `list` commands.
- 331ae4b: Reduce idle Vercel Queue usage and align relay rotation with function limits.

### Patch Changes

- 838c9f6: Add a terminal lifecycle UI for `tt http` and `tt dev` with readiness progress, reconnect notices, shutdown summaries, and clear boundaries between managed dev-server logs and tunnel status.
- 342059e: Remove runtime environment configuration in favor of command options, project configuration, and deployment settings.
- 838c9f6: Use the Effect Fetch HTTP client for local app reachability checks so the published Node.js CLI and the repository CLI running through Bun behave consistently.
- 4b4c396: Harden tunnel handoff, gateway validation and timeouts, local configuration security, redirect forwarding, and WebSocket resource limits. Public WebSocket subprotocol negotiation is now rejected explicitly because the gateway cannot safely negotiate a local protocol before accepting the public upgrade.
