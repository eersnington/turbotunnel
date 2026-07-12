import Link from "next/link";
import { ArrowRight, Terminal, Radio, Server } from "lucide-react";
import { InstallCommand } from "@/components/install-command";

const features: Array<{
  icon: typeof Terminal;
  title: string;
  copy: string;
}> = [
  {
    icon: Terminal,
    title: "Deploy once",
    copy: "tt deploy provisions a gateway on your Vercel account and saves the connection settings.",
  },
  {
    icon: Radio,
    title: "Tunnel a port",
    copy: "tt http <port> gives your local app a public HTTPS URL for as long as the process runs.",
  },
  {
    icon: Server,
    title: "Your account",
    copy: "The gateway, domain, and usage stay on your Vercel project — not a shared SaaS tunnel.",
  },
];

export default function HomePage() {
  return (
    <main className="flex-1 overflow-hidden">
      <section className="relative overflow-hidden">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-24 pb-20 text-center sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-28">
          <div className="inline-flex items-center gap-2 font-mono text-xs text-fd-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Open source localhost tunneling
          </div>

          <h1 className="mt-8 max-w-[18ch] text-balance font-medium text-[2.5rem] leading-[1.05] tracking-tight sm:text-7xl lg:text-8xl">
            Your localhost, on the internet.
          </h1>

          <p className="mt-7 max-w-[46ch] text-pretty text-base leading-relaxed text-fd-muted-foreground sm:text-xl">
            Expose a local HTTP or WebSocket app through a public URL. The gateway
            runs in your Vercel account.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <InstallCommand />
            <Link
              href="/docs"
              className="inline-flex h-11 items-center gap-1.5 rounded-md px-5 text-sm font-medium transition-colors hover:bg-fd-muted"
            >
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-24">
        <p className="font-mono text-xs text-fd-muted-foreground">How it works</p>
        <h2 className="mt-3 max-w-[30ch] text-balance text-4xl font-medium tracking-tight sm:text-5xl">
          Deploy a gateway. Point it at a port.
        </h2>
        <p className="mt-5 max-w-[48ch] text-pretty text-base leading-relaxed text-fd-muted-foreground sm:text-lg">
          Two commands cover the common path: provision once, tunnel whenever you
          need a public URL.
        </p>

        <div className="mt-14 grid gap-12 border-y border-fd-border border-dotted md:grid-cols-3 md:gap-0">
          {features.map(({ icon: Icon, title, copy }, index) => (
            <article
              key={title}
              className={`py-8 md:px-8 ${index > 0 ? "border-t border-fd-border border-dotted md:border-l md:border-t-0" : ""}`}
            >
              <Icon className="size-5 text-fd-muted-foreground" />
              <h3 className="mt-8 text-base font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                {copy}
              </p>
            </article>
          ))}
        </div>

        <pre className="mt-14 overflow-x-auto rounded-md border border-fd-border bg-fd-card p-5 font-mono text-sm leading-7">
          <code>
            <span className="text-fd-muted-foreground">$</span> tt deploy{"\n"}
            <span className="text-fd-muted-foreground">$</span> tt http 5173{"\n\n"}
            <span className="text-emerald-500">●</span> Tunnel ready{"\n"}
            {"  "}
            <span className="text-fd-muted-foreground">Public URL</span>{" "}
            https://demo-turbotunnel.vercel.app
          </code>
        </pre>
      </section>
    </main>
  );
}
