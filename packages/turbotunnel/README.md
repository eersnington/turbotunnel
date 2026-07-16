<p align="center">
  <a href="https://turbotunnel.eers.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/eersnington/turbotunnel/refs/heads/main/media/logo-512-dark.svg?v=3">
      <img src="https://raw.githubusercontent.com/eersnington/turbotunnel/refs/heads/main/media/logo-512.svg?v=3" alt="Turbotunnel" width="192" height="192">
    </picture>
    <h1 align="center">Turbotunnel</h1>
  </a>
</p>

<p align="center">
  <a aria-label="Turbotunnel npm version" href="https://www.npmjs.com/package/turbotunnel"><img alt="npm version" src="https://img.shields.io/npm/v/turbotunnel.svg?style=for-the-badge&labelColor=000000"></a>
  <a aria-label="Turbotunnel license" href="https://github.com/eersnington/turbotunnel/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/turbotunnel.svg?style=for-the-badge&labelColor=000000&v=2"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/eersnington/turbotunnel/refs/heads/main/media/architecture.png" alt="Turbotunnel architecture" width="100%">
</p>

Turbotunnel is a localhost tunnel built on top of [Vercel WebSockets](https://vercel.com/docs/functions/websockets) and [Fluid Compute](https://vercel.com/docs/fluid-compute). It gives a local dev server a public URL, routing traffic through a gateway web server deployed to your own Vercel account. Deploy the gateway once with `tt deploy`. Run `tt http <port>` whenever you want a public URL for the app on your machine.

## Quick start

```sh
npm i -g turbotunnel
vercel login
tt deploy
tt http 5173

Starting tunnel

  Public URL       https://ttdemo123-turbotunnel.vercel.app/
  Local app        http://localhost:5173
```

You need the Vercel CLI installed and logged in for `tt deploy`. Get it with `npm i -g vercel` or [read this](https://vercel.com/docs/cli).

`tt deploy` creates a Vercel project for the gateway and checks that it responds before saving anything to `~/.turbotunnel/config.json`. `tt http` prints a public URL and forwards traffic to your local app until you press `Ctrl-C`.

Use `tt dev` to start the package's `dev` script and tunnel it in one process. `tt status` shows tunnels running on this machine, while `tt list` asks the configured gateway which tunnels are connected.

## Custom domain

By default your gateway lives on `{slug}-turbotunnel.vercel.app`. If you have a domain configured in your Vercel workspace, then pass `--domain` to use your own:

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

`tt deploy` creates the gateway web server and supporting queue in your Vercel deployment. When you run `tt http`, it opens a persistent WebSocket connection to the gateway. Browser requests enter through the gateway and travel over that connection to `tt http`, which forwards them to your local app.

Vercel may run multiple instances of the gateway web server. If a request reaches an instance that does not hold your `tt http` connection, the Vercel Queue provides a cross-instance fallback to the instance that does. Responses return along the same path to the browser.

## Limits

- The public URL works while `tt http` is running
- HTTP requests time out after 30s
- Request and response bodies are limited to 4 MB
- Each tunnel supports up to 32 concurrent public WebSocket connections

The gateway exposes a status endpoint at `/_turbotunnel/status`. It reports version, base domain, queue region, uptime, and live counters for the current instance.

## CLI reference

The CLI is available as `tt` and `turbotunnel`.

### `tt deploy`

```sh
tt deploy
```

Flags:

- **`--project <name>`**: Vercel project name. Defaults to a generated `<slug>-turbotunnel`.
- **`--domain <domain>`**: base tunnel domain or `{slug}` host pattern. Defaults to `{slug}-turbotunnel.vercel.app`.
- **`--region <region>`**: Vercel Queue region. Defaults to `iad1`.
- **`--format json`**: print the deployment result as JSON.

Generates deployment files into `~/.turbotunnel/relay` and writes local settings to `~/.turbotunnel/config.json` after the gateway verifies.

### `tt http <port>`

```sh
tt http 5173
```

Flags:

- **`--slug <slug>`**: tunnel slug for this session. Defaults to a random slug, or the saved one.
- **`--host <host>`**: local host to connect to. Defaults to `localhost`.
- **`--pool <count>`**: number of local client sockets, from `1` to `16`. Defaults to `2`.
- **`--domain <domain>`**: override the tunnel domain for this session.
- **`--secret <secret>`**: use a relay secret for local gateway development.
- **`--relay-url <url>`**: connect to an explicit relay origin, such as `ws://127.0.0.1:3002`.

Checks that the local app is reachable before opening the tunnel. Start your app first.

### `tt dev`

```sh
tt dev
tt dev --port 5173
tt dev -- vite --host 0.0.0.0
```

Starts the nearest package's `dev` script, waits for its HTTP server, and keeps the child process and tunnel in one lifecycle. Pass a custom command after `--`. The child receives `PORT`, `TURBOTUNNEL_URL`, `TURBOTUNNEL_HOST`, and `TURBOTUNNEL_SLUG`.

### `tt status`

```sh
tt status
tt status --format json
```

Shows every live tunnel process on this machine. JSON is written to stdout; terminal output is written to stderr.

### `tt list`

```sh
tt list
tt list --format json
```

Lists tunnels connected to the saved gateway. The result has bounded consistency because it is rebuilt from recent Queue presence events.

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

## License

MIT

## Author

Sree Narayanan ([@eersnington](https://x.com/eersnington))
