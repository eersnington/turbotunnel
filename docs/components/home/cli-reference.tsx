import Link from "next/link";
import { ArrowRight } from "lucide-react";

const commands: CommandProps[] = [
  {
    name: "tt deploy",
    args: "",
    desc: "Provisions the gateway on your Vercel account. Run once to create your public endpoint.",
    href: "/docs/deploy",
  },
  {
    name: "tt http",
    args: "<port>",
    desc: "Start a tunnel to a local port and print a public URL.",
    href: "/docs/http",
  },
];

type CommandProps = {
  name: string;
  args: string;
  desc: string;
  href: string;
};

export function CliReference() {
  return (
    <section className="border-b border-fd-border">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <h2 className="text-2xl font-medium tracking-tight sm:text-3xl text-balance">
          CLI Reference
        </h2>
        <p className="mt-3 max-w-[52ch] text-base leading-relaxed text-fd-muted-foreground text-balance">
          Deploy the gateway once, then open a tunnel to any local port.
        </p>

        <div className="mt-10 divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border">
          {commands.map((command) => (
            <Command key={command.name} {...command} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Command({ name, args, desc, href }: CommandProps) {
  return (
    <div className="grid gap-2 bg-fd-card px-5 py-5 sm:grid-cols-[16rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-8 sm:px-6">
      <code className="font-mono text-sm">
        <span className="text-fd-foreground">{name}</span>
        {args ? <span className="text-fd-muted-foreground"> {args}</span> : null}
      </code>
      <p className="max-w-[72ch] text-balance text-sm leading-relaxed text-fd-muted-foreground">
        {desc}
      </p>
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
      >
        View docs
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
