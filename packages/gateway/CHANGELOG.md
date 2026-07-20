# @turbotunnel/gateway

## 0.1.0

### Patch Changes

- 342059e: Remove runtime environment configuration in favor of command options, project configuration, and deployment settings.
- 0d97490: Redesign gateway error and login pages with clearer documentation links.
- 4b4c396: Harden tunnel handoff, gateway validation and timeouts, local configuration security, redirect forwarding, and WebSocket resource limits. Public WebSocket subprotocol negotiation is now rejected explicitly because the gateway cannot safely negotiate a local protocol before accepting the public upgrade.
  - @turbotunnel/contracts@0.1.0
