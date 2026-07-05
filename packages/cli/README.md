# Turbotunnel

Turbotunnel is a localhost tunnel built on top of [Vercel WebSockets](https://vercel.com/docs/functions/websockets) and [Fluid Compute](https://vercel.com/docs/fluid-compute). It gives a local dev server a public URL, routing traffic through a relay in your own Vercel account. Deploy the relay once with `tt deploy`. Run `tt http <port>` whenever you want a public URL for the app on your machine.

## Quick start

```sh
npm i -g turbotunnel
vercel login
tt deploy
tt http 5173

Starting tunnel

  Public URL       https://ttdemo-turbotunnel.vercel.app/
  Local app        http://localhost:5173
```

You need the Vercel CLI installed and logged in for `tt deploy`. Get it with `npm i -g vercel` or [read this](https://vercel.com/docs/cli).

`tt deploy` creates a Vercel project for the relay and checks that it responds before saving anything to `~/.turbotunnel/config.json`. `tt http` prints a public URL and forwards traffic to your local app until you press `Ctrl-C`.

## Custom domain

By default your relay lives on `{slug}-turbotunnel.vercel.app`. If you have a domain configured in your Vercel workspace, then pass `--domain` to use your own:

```sh
tt deploy --domain tunnel.example.com
tt http 5173 --slug demo
```

This exposes `https://demo.tunnel.example.com/`. Use a `{slug}` token to place the slug elsewhere in the host:

```sh
tt deploy --domain "{slug}.dev.example.com"
tt http 5173 --slug demo
```

This exposes `https://demo.dev.example.com/`.

## How it works

```
  Browser            Relay (Vercel)            Local client            Your app
  ────────           ──────────────            ────────────            ────────

                      ┌──────────┐   open WS    ┌─────────┐
── HTTP/WS ─────────▶ │  relay   │◀─────────────│ tt http │────────▶ localhost:5173
                      └──────────┘              └─────────┘
```

The relay is a Vercel WebSocket Function you deploy with `tt deploy`. `tt http` opens a WebSocket to the relay and keeps it alive. When a browser hits your tunnel URL, the relay forwards the request to your local app over that socket.

Vercel can run multiple instances of the relay. Only one of them holds your WebSocket connection. When a request lands on a different instance, it routes through a Vercel Queue to reach the right one.

## Limits

- The public URL works while `tt http` is running
- HTTP requests time out after 30s
- Request and response bodies are limited to 4 MB
- Each tunnel supports up to 32 concurrent public WebSocket connections

The relay exposes a status endpoint at `/_turbotunnel/status`. It reports version, base domain, queue region, uptime, and live counters for the current instance.

## CLI Reference

The CLI is available as `tt` and `turbotunnel`.

### `tt deploy`

```sh
tt deploy
```

Flags:

- **`--project <name>`**: Vercel project name. Defaults to a generated `<slug>-turbotunnel`.
- **`--domain <domain>`**: base tunnel domain or `{slug}` host pattern. Defaults to `{slug}-turbotunnel.vercel.app`.
- **`--region <region>`**: Vercel Queue region. Defaults to `iad1`.

Generates deployment files into `~/.turbotunnel/relay` and writes local settings to `~/.turbotunnel/config.json` after the relay verifies.

### `tt http <port>`

```sh
tt http 5173
```

Flags:

- **`--slug <slug>`**: tunnel slug for this session. Defaults to a random slug, or the saved one.
- **`--host <host>`**: local host to connect to. Defaults to `localhost`.
- **`--pool <count>`**: number of local client sockets. Defaults to `2`.
- **`--domain <domain>`**: override the tunnel domain for this session.
- **`--relay-url <url>`**: connect to an explicit relay origin, such as `ws://127.0.0.1:3002`.

Checks that the local app is reachable before opening the tunnel. Start your app first.

### Environment variables

Use these for scripted runs or development overrides:

- `TURBOTUNNEL_SLUG`: tunnel slug
- `TURBOTUNNEL_BASE_DOMAIN`: base tunnel domain
- `TURBOTUNNEL_RELAY_DOMAIN`: relay domain
- `TURBOTUNNEL_RELAY_SECRET`: relay secret
- `TURBOTUNNEL_RELAY_URL`: explicit relay origin

For normal use, prefer `tt deploy` and the saved config file.

## Develop

Prerequisites: 
- Bun 1.3.14+
- Node.js 22+


Run the CLI from the repo during development:

```sh
bun run tt -- deploy
bun run tt -- http 5173
```

Or use the workspace shortcuts:

```sh
bun run tt:deploy
bun run tt:http 5173
```

# Author

Sree Narayanan ([@eersnington](https://x.com/eersnington))