import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { InstallCommand } from "@/components/install-command";
import { CliReference } from "@/components/home/cli-reference";
import { FlowDiagram } from "@/components/home/flow-diagram";

export default function HomePage() {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section>
        <div className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-24 pb-20 text-center sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-28">
          <h1 className="max-w-[16ch] text-balance text-[2.4rem] font-medium leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            Connect the Web to your Localhost
          </h1>
          <p className="mt-6 max-w-[48ch] text-base leading-relaxed text-fd-muted-foreground sm:text-lg text-balance">
            A tunneling service which you can deploy to your Vercel account. Built on top of Fluid
            Compute and WebSockets.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <InstallCommand />
            <Link
              href="/docs"
              className="inline-flex h-11 items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors hover:bg-fd-muted"
            >
              Quickstart
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* The one visualization */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl text-balance">
            How it Works
          </h2>
          <p className="mt-3 max-w-[72ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Turbotunnel connects your machine to the gateway over WebSockets, carrying requests to
            your local app and responses back. If a request lands on an instance without that
            connection, Vercel Queue sends it to one that has it.
          </p>
          <div className="mt-10">
            <FlowDiagram />
          </div>
        </div>
      </section>

      <CliReference />

      {/* Footer */}
      <section>
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-20 sm:flex-row sm:items-center sm:justify-between lg:py-24">
          <p className="max-w-[36ch] text-base leading-relaxed text-fd-muted-foreground">
            Built with <span className="dark:hidden">🖤</span>
            <span className="hidden dark:inline">🤍</span> by{" "}
            <a
              href="https://x.com/eersnington"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fd-foreground"
            >
              eersnington
            </a>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <InstallCommand />
            <Link
              href="/docs"
              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-5 text-sm font-medium transition-colors hover:bg-fd-muted"
            >
              Read the docs
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
