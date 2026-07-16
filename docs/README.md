# docs

The Turbotunnel documentation site uses [Blume](https://useblume.dev).

Install dependencies from the workspace root, then start the docs server:

```sh
bun install
bun run --cwd docs dev
```

Open <http://localhost:1024>.

## Structure

- `blume.config.ts` configures the site, navigation, search, and deployment.
- `content/docs/` contains the documentation pages served under `/docs`.
- `pages/index.astro` is the custom landing page.
- `components/` contains static Astro components.
- `islands/` contains interactive React components.
- `theme.css` contains site-level token overrides.

## Commands

```sh
bun run --cwd docs check-types
bun run --cwd docs validate
bun run --cwd docs build
bun run --cwd docs preview
```
