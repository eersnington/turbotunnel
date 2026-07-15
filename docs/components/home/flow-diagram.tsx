"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Globe, Cloud, TerminalSquare, AppWindow } from "lucide-react";

/**
 * The one and only landing visualization.
 *
 * Tells the whole story in a single line:
 *   a public visitor  →  a URL deployed on Vercel  →  the tunnel running
 *   on your machine  →  your local app.
 *
 * The line between "Vercel" and "TurboTunnel" is the tunnel: a single
 * packet travels out (request) and comes back (response) to make the
 * round trip obvious. Animation is one GSAP timeline, transform-only,
 * and disabled under prefers-reduced-motion.
 */
export function FlowDiagram() {
  const trackRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const dot = dotRef.current;
    if (!track || !dot) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return;

    const req = getComputedStyle(document.documentElement)
      .getPropertyValue("--home-ok")
      .trim();
    const res = getComputedStyle(document.documentElement)
      .getPropertyValue("--home-response")
      .trim();

    const ctx = gsap.context(() => {
      const distance = () => track.clientWidth - dot.offsetWidth;

      const tl = gsap.timeline({ repeat: -1, defaults: { ease: "power1.inOut" } });
      tl.set(dot, { x: 0, backgroundColor: req, boxShadow: `0 0 6px ${req}`, opacity: 0 })
        // request: left → right
        .to(dot, { opacity: 1, duration: 0.2 })
        .to(dot, { x: distance, duration: 1.1 })
        .to(dot, { opacity: 0, duration: 0.2 })
        // become a response and travel back: right → left
        .set(dot, { backgroundColor: res, boxShadow: `0 0 6px ${res}` })
        .to(dot, { opacity: 1, duration: 0.2 })
        .to(dot, { x: 0, duration: 1.1 })
        .to(dot, { opacity: 0, duration: 0.2 })
        .to({}, { duration: 0.3 });

      const onResize = () => tl.invalidate();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    });

    return () => ctx.revert();
  }, []);

  return (
    <div className="rounded-lg border border-fd-border bg-fd-card p-5 sm:p-8">
      {/* Nodes */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <Node
          icon={<Globe className="size-5" strokeWidth={1.5} />}
          title="Browser"
          sub="any visitor"
        />
        <Node
          icon={<Cloud className="size-5" strokeWidth={1.5} />}
          title="Vercel Gateway"
          sub="public https URL"
        />
        <Node
          icon={<TerminalSquare className="size-5" strokeWidth={1.5} />}
          title="TurboTunnel"
          sub="running on your machine"
          accent
        />
        <Node
          icon={<AppWindow className="size-5" strokeWidth={1.5} />}
          title="Your App"
          sub="localhost:5173"
        />
      </div>

      {/* Tunnel line with a single round-trip packet */}
      <div className="mt-6 flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fd-muted-foreground">
          public web
        </span>
        <div ref={trackRef} className="relative h-px flex-1 bg-fd-border" aria-hidden>
          <span
            ref={dotRef}
            className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full opacity-0"
          />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-fd-muted-foreground">
          your machine
        </span>
      </div>

      {/* Legend */}
      <div className="mt-4 flex items-center gap-5 font-mono text-[11px] text-fd-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--home-ok)]" />
          request
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--home-response)]" />
          response
        </span>
      </div>
    </div>
  );
}

function Node({
  icon,
  title,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 ${
        accent
          ? "border-[color-mix(in_oklch,var(--home-ok)_35%,var(--fd-border))] bg-[color-mix(in_oklch,var(--home-ok)_6%,var(--fd-card))]"
          : "border-fd-border bg-fd-background"
      }`}
    >
      <span
        className={`flex size-9 items-center justify-center rounded-md border ${
          accent
            ? "border-[color-mix(in_oklch,var(--home-ok)_35%,var(--fd-border))] text-[var(--home-ok)]"
            : "border-fd-border text-fd-muted-foreground"
        }`}
      >
        {icon}
      </span>
      <div>
        <div className="font-mono text-sm font-medium text-fd-foreground">{title}</div>
        <div className="mt-0.5 font-mono text-[11px] leading-tight text-fd-muted-foreground">
          {sub}
        </div>
      </div>
    </div>
  );
}
