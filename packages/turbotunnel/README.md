<p align="center">
  <a href="https://turbotunnel.dev">
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
  <img src="https://raw.githubusercontent.com/eersnington/turbotunnel/refs/heads/main/media/architecture.png" alt="Browser traffic passes through a Vercel gateway and relay sockets to a local app, with Vercel Queue between gateway instances" width="100%">
</p>

Turbotunnel gives a local HTTP or WebSocket app a public URL through a gateway deployed to your Vercel account.

## Get started

Install Turbotunnel and the [Vercel CLI](https://vercel.com/docs/cli), then authenticate:

```sh
npm i -g turbotunnel vercel
vercel login
```

Deploy your gateway once, start your local app, and open a tunnel to its port:

```sh
tt deploy
tt http 5173
```

`tt http` prints the public URL and forwards traffic until you press `Ctrl-C`. See the [get started guide](https://turbotunnel.dev/docs) for the complete setup flow.

## Architecture

1. A browser sends an HTTP or WebSocket request to your Vercel gateway.
2. The gateway forwards the request through a persistent relay WebSocket to `tt`.
3. `tt` sends the request to your local app and returns its response.

The relay uses a configurable pool of 1 to 16 sockets and defaults to 2. If a Vercel instance has no eligible relay connection, Vercel Queue forwards the request to an instance connected to your machine.

Read [how Turbotunnel works](https://turbotunnel.dev/docs/how-it-works) for gateway status, presence, and retry behavior.

## Limits

| Surface               | Limit                                  |
| --------------------- | -------------------------------------- |
| Tunnel availability   | While `tt http` or `tt dev` runs       |
| HTTP request duration | 30s                                    |
| Request body          | 4 MiB (4,194,304 bytes)                |
| Response body         | 4 MiB (4,194,304 bytes)                |
| Direct HTTP capacity  | 32 in-flight requests per relay socket |
| Public WebSockets     | 32 per slug per gateway instance       |
| Relay pool            | 1 to 16 sockets; default 2             |

See [Turbotunnel limits](https://turbotunnel.dev/docs/limits) for scopes and HTTP or WebSocket failure behavior.

## Common tasks

- [Deploy a gateway and configure domains](https://turbotunnel.dev/docs/deploy)
- [Expose an already-running app with `tt http`](https://turbotunnel.dev/docs/http)
- [Run a development server with `tt dev`](https://turbotunnel.dev/docs/dev)
- [Inspect local tunnels with `tt status`](https://turbotunnel.dev/docs/status)
- [List gateway-reported tunnels with `tt list`](https://turbotunnel.dev/docs/list)
- [Configure runtime overrides](https://turbotunnel.dev/docs/configuration)
- [Troubleshoot failures](https://turbotunnel.dev/docs/troubleshooting)

## Development

The repository requires Bun 1.3.14 or newer and Node.js 22 or newer:

```sh
bun install
bun run tt -- http 5173
```

## License

MIT
