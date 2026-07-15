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

      {/* How you use it — two commands */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl text-balance">
            Two commands. That&apos;s the whole thing.
          </h2>
          <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Deploy the gateway once, then open a tunnel whenever you need one.
          </p>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <Step
              n={1}
              title="Deploy the gateway"
              desc="Creates a Vercel project that acts as your public endpoint. You only do this once."
              terminal={{
                title: "tt deploy",
                lines: [
                  { t: "cmd", v: "tt deploy" },
                  { t: "dim", v: "Creating Vercel project…" },
                  { t: "dim", v: "Verifying /_turbotunnel/status" },
                  { t: "ok", v: "Gateway live · config saved" },
                ],
              }}
            />
            <Step
              n={2}
              title="Open a tunnel"
              desc="Point the tunnel at a local port. You get a shareable https URL that forwards straight to your app."
              terminal={{
                title: "tt http",
                lines: [
                  { t: "cmd", v: "tt http 5173 --slug checkout" },
                  { t: "dim", v: "Connecting to localhost:5173" },
                  { t: "dim", v: "Opening relay socket…" },
                  { t: "ok", v: "https://checkout-turbotunnel.vercel.app" },
                ],
              }}
            />
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

function Step({
  n,
  title,
  desc,
  terminal,
}: {
  n: number;
  title: string;
  desc: string;
  terminal: { title: string; lines: Array<{ t: "cmd" | "dim" | "ok"; v: string }> };
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-fd-border font-mono text-xs text-fd-muted-foreground">
          {n}
        </span>
        <div>
          <h3 className="text-base font-medium tracking-tight">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-fd-muted-foreground text-pretty">
            {desc}
          </p>
        </div>
      </div>
      <Terminal title={terminal.title} lines={terminal.lines} />
    </div>
  );
}

function Terminal({
  title,
  lines,
}: {
  title: string;
  lines: Array<{ t: "cmd" | "dim" | "ok"; v: string }>;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-fd-border bg-fd-card">
      <div className="flex items-center gap-2 border-b border-fd-border px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-fd-border" />
          <span className="size-2.5 rounded-full bg-fd-border" />
          <span className="size-2.5 rounded-full bg-fd-border" />
        </span>
        <span className="ml-1 font-mono text-[11px] text-fd-muted-foreground">{title}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-7 sm:text-[13px]">
        <code>
          {lines.map((line, i) => {
            if (line.t === "cmd") {
              return (
                <span key={i} className="block">
                  <span className="text-fd-muted-foreground">$ </span>
                  {line.v}
                </span>
              );
            }
            if (line.t === "ok") {
              return (
                <span key={i} className="block">
                  <span className="text-emerald-500">● </span>
                  {line.v}
                </span>
              );
            }
            return (
              <span key={i} className="block text-fd-muted-foreground">
                {line.v}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
