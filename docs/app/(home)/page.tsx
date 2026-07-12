import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { InstallCommand } from "@/components/install-command";
import { DomainScene } from "@/components/home/domain-scene";
import { RequestScene } from "@/components/home/request-scene";
import { FallbackScene } from "@/components/home/fallback-scene";

export default function HomePage() {
  return (
    <main className="flex-1">
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

      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
            Forward requests to localhost.
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            HTTP requests and WebSocket upgrades use the same active connection.
          </p>
          <div className="mt-10">
            <RequestScene />
          </div>
        </div>
      </section>

      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
            Use a domain and a name.
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Choose a slug per session or configure a wildcard domain during deployment.
          </p>
          <div className="mt-10">
            <DomainScene />
          </div>
        </div>
      </section>

      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
            Route across gateway instances.
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            Vercel Queue forwards requests to the instance holding the tunnel connection.
          </p>
          <div className="mt-10">
            <FallbackScene />
          </div>
        </div>
      </section>

      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">Deploy. Connect.</h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
            <code className="font-mono text-fd-foreground">tt deploy</code> deploys a webserver
            gateway to your Vercel Account.{" "}
            <code className="font-mono text-fd-foreground">tt http</code>{" "}
            <code className="font-mono text-fd-foreground">&lt;port&gt;</code> opens a tunnel.
          </p>
          <div className="mt-10 grid gap-px overflow-hidden rounded-md border border-fd-border bg-fd-border md:grid-cols-2">
            <CommandBlock
              title="tt deploy"
              lines={[
                { t: "cmd", v: "tt deploy" },
                { t: "dim", v: "Creates a Vercel project" },
                { t: "dim", v: "Verifies /_turbotunnel/status" },
                { t: "ok", v: "Config saved" },
              ]}
            />
            <CommandBlock
              title="tt http"
              lines={[
                { t: "cmd", v: "tt http 5173 --slug checkout" },
                { t: "dim", v: "Checks localhost:5173" },
                { t: "dim", v: "Opens relay sockets" },
                { t: "ok", v: "https://checkout-turbotunnel.vercel.app" },
              ]}
            />
          </div>
        </div>
      </section>

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

function CommandBlock({
  title,
  lines,
}: {
  title: string;
  lines: Array<{ t: "cmd" | "dim" | "ok"; v: string }>;
}) {
  return (
    <div className="bg-fd-card">
      <div className="border-b border-fd-border px-4 py-2.5 font-mono text-[11px] text-fd-muted-foreground">
        {title}
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
