---
"turbotunnel": patch
"@turbotunnel/gateway": patch
---

Harden tunnel handoff, gateway validation and timeouts, local configuration security, redirect forwarding, and WebSocket resource limits. Public WebSocket subprotocol negotiation is now rejected explicitly because the gateway cannot safely negotiate a local protocol before accepting the public upgrade.
