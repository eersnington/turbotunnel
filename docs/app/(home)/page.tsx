import Link from "next/link";
import { ArrowRight, Code2, Radio, Terminal } from "lucide-react";

const features: Array<{
  icon: typeof Terminal;
  title: string;
  copy: string;
}> = [
  {
    icon: Terminal,
    title: "One command",
    copy: "Point Turbotunnel at a port and get a public HTTPS URL in seconds.",
  },
  {
    icon: Radio,
    title: "Persistent connection",
    copy: "Requests travel over WebSockets directly to the app running on your machine.",
  },
  {
    icon: Code2,
    title: "Your Vercel account",
    copy: "Deploy the gateway once and keep ownership of the infrastructure and domain.",
  },
];

export default function HomePage() {
  return (
    <main className="flex-1 overflow-hidden">
      <section className="relative border-b dotted-divider">
        <div className="dot-grid absolute inset-0 opacity-35 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]" />
        <div className="relative mx-auto flex max-w-5xl flex-col items-center px-6 pb-24 pt-24 text-center sm:pb-32 sm:pt-36 lg:pt-40">
          <div className="inline-flex items-center gap-2 font-mono text-xs text-fd-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_color-mix(in_oklab,#10b981_15%,transparent)]" />
            Open source localhost tunneling
          </div>
          <h1 className="mt-8 max-w-[15ch] text-balance text-[3rem] font-medium leading-[0.98] tracking-[-0.055em] sm:text-7xl lg:text-8xl">
            Your localhost, on the internet.
          </h1>
          <p className="mt-7 max-w-[48ch] text-pretty text-base leading-relaxed text-fd-muted-foreground sm:text-xl">
            A fast public URL for any local app, powered by Vercel WebSockets and Fluid Compute.
            Deploy once, tunnel whenever you need it.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-transform hover:-translate-y-0.5"
            >
              Get started <ArrowRight className="size-4" />
            </Link>
            <a
              href="https://github.com/eersnington/turbotunnel"
              className="inline-flex h-11 items-center gap-2 rounded-full border px-5 text-sm font-medium transition-colors hover:bg-fd-muted"
              target="_blank"
              rel="noreferrer"
            >
              <Code2 className="size-4" /> GitHub
            </a>
          </div>
          <div className="mt-14 w-full max-w-2xl overflow-hidden rounded-2xl border bg-fd-card text-left shadow-2xl shadow-blue-500/5">
            <div className="flex h-10 items-center gap-1.5 border-b px-4">
              <span className="size-2 rounded-full bg-red-400/70" />
              <span className="size-2 rounded-full bg-amber-400/70" />
              <span className="size-2 rounded-full bg-emerald-400/70" />
              <span className="ml-3 font-mono text-[11px] text-fd-muted-foreground">terminal</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-sm leading-7">
              <code>
                <span className="text-fd-muted-foreground">$</span> npm i -g turbotunnel{`\n`}
                <span className="text-fd-muted-foreground">$</span> tt http 5173{`\n\n`}
                <span className="text-emerald-500">●</span> Tunnel ready{`\n`}{" "}
                <span className="text-fd-muted-foreground">Public URL</span>{" "}
                https://demo-turbotunnel.vercel.app
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
        <p className="font-mono text-xs text-fd-muted-foreground">A shorter path to public</p>
        <h2 className="mt-3 max-w-[24ch] text-balance text-4xl font-medium tracking-tight sm:text-5xl">
          Built for the inner loop, not another infrastructure project.
        </h2>
        <div className="mt-14 grid border-y dotted-divider md:grid-cols-3">
          {features.map(({ icon: Icon, title, copy }, index) => (
            <article
              key={title}
              className={`py-8 md:px-8 ${index > 0 ? "border-t dotted-divider md:border-l md:border-t-0" : ""}`}
            >
              <Icon className="size-5 text-blue-500" />
              <h3 className="mt-8 font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{copy}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
