import { defineConfig } from "blume";

export default defineConfig({
  title: "Turbotunnel",
  description: "Tunnel your local dev server with a public URL, powered by Vercel WebSockets.",
  logo: {
    image: {
      light: "/logo.svg",
      dark: "/logo-dark.svg",
      alt: "Turbotunnel",
    },
    text: "Turbotunnel",
    href: "/",
  },
  content: {
    root: "content",
  },
  github: {
    owner: "eersnington",
    repo: "turbotunnel",
    branch: "main",
    dir: "docs",
  },
  navigation: {
    tabs: [{ label: "Docs", path: "/docs" }],
  },
  theme: {
    accent: "blue",
    radius: "sm",
    mode: "system",
    fonts: {
      display: "inter",
      body: "inter",
      mono: "geist-mono",
    },
    background: {
      light: "oklch(1 0 0)",
      dark: "oklch(0.085 0 0)",
    },
  },
  search: {
    provider: "orama",
  },
  ai: {
    llmsTxt: true,
  },
  seo: {
    og: { enabled: true, logo: "/logo.svg" },
    sitemap: true,
    robots: true,
    structuredData: true,
  },
  deployment: {
    output: "static",
  },
});
