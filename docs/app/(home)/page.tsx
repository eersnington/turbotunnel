import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { InstallCommand } from "@/components/install-command";
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
          <p className="mt-6 max-w-[48ch] text-pretty text-base leading-relaxed text-fd-muted-foreground sm:text-lg text-balance">
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
            A public URL that points at your machine.
          </h2>
          <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Traffic hits a gateway deployed on your Vercel account, rides a WebSocket down to the
            tunnel running on your machine, and reaches your local app. Responses take the same path
            back.
          </p>
          <div className="mt-10">
            <FlowDiagram />
          </div>
        </div>
      </section>

      {/* Command reference */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl text-balance">
            The CLI
          </h2>
          <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Deploy the gateway once, then open a tunnel to any local port.
          </p>

          <div className="mt-10 divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border">
            {commands.map((cmd) => (
              <Command key={cmd.name} {...cmd} />
            ))}
          </div>
        </div>
      </section>

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

const commands: CommandProps[] = [
  {
    name: "tt deploy",
    args: "",
    desc: "Provisions the gateway on your Vercel account. Run once to create your public endpoint.",
  },
  {
    name: "tt http",
    args: "<port>",
    desc: "Forwards a local port over the tunnel and prints a public URL. Pass --slug to pick the subdomain.",
  },
];

type CommandProps = {
  name: string;
  args: string;
  desc: string;
};

function Command({ name, args, desc }: CommandProps) {
  return (
    <div className="flex flex-col gap-2 bg-fd-card px-5 py-5 sm:flex-row sm:items-baseline sm:gap-8 sm:px-6">
      <code className="shrink-0 font-mono text-sm sm:w-64">
        <span className="text-fd-foreground">{name}</span>
        {args ? <span className="text-fd-muted-foreground"> {args}</span> : null}
      </code>
      <p className="max-w-[56ch] text-sm leading-relaxed text-fd-muted-foreground text-pretty">
        {desc}
      </p>
    </div>
  );
}
