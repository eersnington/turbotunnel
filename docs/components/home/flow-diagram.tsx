"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Globe, Triangle, TerminalSquare, AppWindow } from "lucide-react";

/**
 * The one landing visualization.
 *
 * Core idea to communicate: your machine normally sits behind a boundary
 * (NAT / firewall) that the public internet cannot reach. TurboTunnel opens
 * a persistent WebSocket that crosses that boundary, so a public Vercel URL
 * can reach straight into localhost.
 *
 * Layout: PUBLIC WEB zone (Browser, Gateway) on the left, a dashed boundary
 * in the middle, YOUR MACHINE zone (TurboTunnel, App) on the right. Packets
 * flow continuously both ways along the connection line — green requests
 * inbound, blue responses outbound. One GSAP context, transform + opacity
 * only, disabled under prefers-reduced-motion.
 */
const REQUEST_DOTS = 3;
const RESPONSE_DOTS = 3;
const TRAVEL = 3.2; // seconds for a full pass

export function FlowDiagram() {
  const trackRef = useRef<HTMLDivElement>(null);
  const reqRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const resRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return;

    const ctx = gsap.context(() => {
      const dist = () => track.clientWidth;

      const build = (
        el: HTMLSpanElement | null,
        i: number,
        total: number,
        dir: "in" | "out",
      ) => {
        if (!el) return;
        const from = dir === "in" ? -12 : dist() + 12;
        const to = dir === "in" ? dist() + 12 : -12;
        gsap.set(el, { x: from, opacity: 0 });
        gsap.to(el, {
          keyframes: [
            { opacity: 1, duration: 0.12 },
            { opacity: 1, duration: 0.76 },
            { opacity: 0, duration: 0.12 },
          ],
          x: to,
          duration: TRAVEL,
          ease: "none",
          repeat: -1,
          delay: (i / total) * TRAVEL,
        });
      };

      reqRefs.current.forEach((el, i) => build(el, i, REQUEST_DOTS, "in"));
      resRefs.current.forEach((el, i) => build(el, i, RESPONSE_DOTS, "out"));
    });

    return () => ctx.revert();
  }, []);

  return (
    <div className="relative overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      {/* Zone tint: right half = your machine */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[color-mix(in_oklch,var(--home-ok)_4%,transparent)]"
      />
      {/* Boundary: NAT / firewall */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-6 left-1/2 hidden w-px -translate-x-1/2 border-l border-dashed border-fd-border sm:block"
      />

      {/* Zone labels */}
      <div className="relative flex items-center justify-between px-5 pt-5 sm:px-8">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-fd-muted-foreground">
          Public web
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--home-ok)]">
          Your machine
        </span>
      </div>

      {/* Nodes */}
      <div className="relative grid grid-cols-2 gap-3 p-5 sm:grid-cols-4 sm:gap-4 sm:p-8 sm:pt-4">
        <Node icon={<Globe className="size-5" strokeWidth={1.5} />} title="Browser" sub="any visitor" />
        <Node
          icon={<Triangle className="size-4 fill-current" strokeWidth={0} />}
          title="Vercel Gateway"
          sub="public https URL"
        />
        <Node
          icon={<TerminalSquare className="size-5" strokeWidth={1.5} />}
          title="TurboTunnel"
          sub="the tt CLI, on your machine"
          accent
        />
        <Node
          icon={<AppWindow className="size-5" strokeWidth={1.5} />}
          title="Your App"
          sub="localhost:5173"
          accent
        />
      </div>

      {/* Connection line with continuous bidirectional packets */}
      <div className="relative px-5 pb-5 sm:px-8 sm:pb-8">
        <div ref={trackRef} className="relative h-8" aria-hidden>
          {/* request rail */}
          <div className="absolute left-0 right-0 top-2.5 h-px bg-fd-border" />
          {/* response rail */}
          <div className="absolute left-0 right-0 bottom-2.5 h-px bg-fd-border" />

          {Array.from({ length: REQUEST_DOTS }).map((_, i) => (
            <span
              key={`req-${i}`}
              ref={(el) => {
                reqRefs.current[i] = el;
              }}
              className="absolute left-0 top-2.5 size-2 -translate-y-1/2 rounded-full bg-[var(--home-ok)]"
              style={{ boxShadow: "0 0 6px var(--home-ok)" }}
            />
          ))}
          {Array.from({ length: RESPONSE_DOTS }).map((_, i) => (
            <span
              key={`res-${i}`}
              ref={(el) => {
                resRefs.current[i] = el;
              }}
              className="absolute left-0 bottom-2.5 size-2 translate-y-1/2 rounded-full bg-[var(--home-response)]"
              style={{ boxShadow: "0 0 6px var(--home-response)" }}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="mt-3 flex items-center gap-5 font-mono text-[11px] text-fd-muted-foreground">
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
          ? "border-[color-mix(in_oklch,var(--home-ok)_30%,var(--fd-border))] bg-[color-mix(in_oklch,var(--home-ok)_6%,var(--fd-card))]"
          : "border-fd-border bg-fd-background"
      }`}
    >
      <span
        className={`flex size-9 items-center justify-center rounded-md border ${
          accent
            ? "border-[color-mix(in_oklch,var(--home-ok)_30%,var(--fd-border))] text-[var(--home-ok)]"
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
