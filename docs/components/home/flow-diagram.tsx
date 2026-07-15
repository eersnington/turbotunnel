"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";

/**
 * The one landing visualization.
 *
 * Core idea: your machine sits behind a boundary (NAT / firewall) the public
 * internet cannot reach. TurboTunnel opens a persistent connection that
 * pierces that boundary, so a public Vercel URL reaches straight into
 * localhost.
 *
 * This is drawn as a single SVG scene so the connection can be a real curved
 * "cable" that dips through the firewall line — a public browser window on the
 * left, a terminal (your machine) on the right. Green request packets flow in
 * along the top of the cable, blue response packets flow back out along the
 * bottom. GSAP MotionPathPlugin animates the packets along the curve;
 * transform/opacity only, disabled under prefers-reduced-motion.
 */

// Two lanes of the tunnel cable. Both dip down and cross the firewall (x=500).
const REQ_PATH = "M348,168 C 452,168 452,250 500,250 C 548,250 548,168 652,168";
const RES_PATH = "M652,196 C 548,196 548,286 500,286 C 452,286 452,196 348,196";

const REQ_DOTS = 3;
const RES_DOTS = 3;
const TRAVEL = 3.4;

export function FlowDiagram() {
  const rootRef = useRef<SVGSVGElement>(null);
  const reqPathRef = useRef<SVGPathElement>(null);
  const resPathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const reqPath = reqPathRef.current;
    const resPath = resPathRef.current;
    if (!root || !reqPath || !resPath) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(MotionPathPlugin);

    const ctx = gsap.context(() => {
      const run = (selector: string, path: SVGPathElement, count: number) => {
        gsap.utils.toArray<SVGCircleElement>(selector).forEach((dot, i) => {
          gsap
            .timeline({ repeat: -1, delay: (i / count) * TRAVEL })
            .to(dot, {
              motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
              duration: TRAVEL,
              ease: "none",
            })
            .fromTo(
              dot,
              { opacity: 0 },
              { opacity: 1, duration: 0.14 },
              0,
            )
            .to(dot, { opacity: 0, duration: 0.14 }, TRAVEL - 0.14);
        });
      };

      run(".tt-req", reqPath, REQ_DOTS);
      run(".tt-res", resPath, RES_DOTS);
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <svg
        ref={rootRef}
        viewBox="0 0 1000 400"
        className="block h-auto w-full font-mono"
        role="img"
        aria-label="A public browser request travels through the Vercel gateway and a persistent tunnel that pierces your firewall to reach your local app, and the response returns the same way."
        preserveAspectRatio="xMidYMid meet"
      >
        {/* right zone tint = your machine */}
        <rect x="500" y="0" width="500" height="400" fill="var(--home-ok)" opacity="0.035" />

        {/* firewall / NAT boundary */}
        <line
          x1="500"
          y1="40"
          x2="500"
          y2="392"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="4 5"
          className="text-fd-muted-foreground"
          opacity="0.4"
        />
        <text
          x="500"
          y="30"
          textAnchor="middle"
          fontSize="11"
          letterSpacing="2"
          className="fill-fd-muted-foreground"
        >
          FIREWALL / NAT
        </text>

        {/* zone labels */}
        <text x="40" y="30" fontSize="11" letterSpacing="2" className="fill-fd-muted-foreground">
          PUBLIC INTERNET
        </text>
        <text
          x="960"
          y="30"
          textAnchor="end"
          fontSize="11"
          letterSpacing="2"
          fill="var(--home-ok)"
        >
          YOUR MACHINE
        </text>

        {/* ── tunnel cable ─────────────────────────────────────────── */}
        {/* faint rails */}
        <path ref={reqPathRef} d={REQ_PATH} fill="none" stroke="var(--home-ok)" strokeWidth="1.25" opacity="0.28" />
        <path ref={resPathRef} d={RES_PATH} fill="none" stroke="var(--home-response)" strokeWidth="1.25" opacity="0.28" />

        {/* animated packets */}
        {Array.from({ length: REQ_DOTS }).map((_, i) => (
          <circle
            key={`req-${i}`}
            className="tt-req"
            r="4.5"
            cx="0"
            cy="0"
            fill="var(--home-ok)"
            opacity="0"
            style={{ filter: "drop-shadow(0 0 5px var(--home-ok))" }}
          />
        ))}
        {Array.from({ length: RES_DOTS }).map((_, i) => (
          <circle
            key={`res-${i}`}
            className="tt-res"
            r="4.5"
            cx="0"
            cy="0"
            fill="var(--home-response)"
            opacity="0"
            style={{ filter: "drop-shadow(0 0 5px var(--home-response))" }}
          />
        ))}

        {/* ── Browser window (public) ──────────────────────────────── */}
        <BrowserWindow />

        {/* ── Terminal window (your machine) ───────────────────────── */}
        <TerminalWindow />

        {/* legend */}
        <g transform="translate(40, 372)">
          <circle cx="4" cy="-4" r="4" fill="var(--home-ok)" />
          <text x="16" y="0" fontSize="12" className="fill-fd-muted-foreground">request</text>
          <circle cx="104" cy="-4" r="4" fill="var(--home-response)" />
          <text x="116" y="0" fontSize="12" className="fill-fd-muted-foreground">response</text>
        </g>
      </svg>
    </div>
  );
}

function BrowserWindow() {
  return (
    <g>
      <rect
        x="40"
        y="70"
        width="308"
        height="196"
        rx="10"
        fill="currentColor"
        fillOpacity="0.03"
        stroke="currentColor"
        strokeOpacity="0.16"
        className="text-fd-foreground"
      />
      {/* chrome */}
      <line x1="40" y1="104" x2="348" y2="104" stroke="currentColor" strokeOpacity="0.16" className="text-fd-foreground" />
      <circle cx="62" cy="87" r="4" className="fill-fd-muted-foreground" opacity="0.6" />
      <circle cx="78" cy="87" r="4" className="fill-fd-muted-foreground" opacity="0.6" />
      <circle cx="94" cy="87" r="4" className="fill-fd-muted-foreground" opacity="0.6" />
      <rect x="120" y="79" width="212" height="17" rx="4" fill="currentColor" fillOpacity="0.06" className="text-fd-foreground" />
      <text x="130" y="91" fontSize="10" className="fill-fd-muted-foreground">
        checkout-turbotunnel.vercel.app
      </text>

      {/* page content: a checkout mock */}
      <rect x="64" y="126" width="104" height="88" rx="5" fill="currentColor" fillOpacity="0.05" className="text-fd-foreground" />
      <rect x="184" y="130" width="130" height="10" rx="3" fill="currentColor" fillOpacity="0.14" className="text-fd-foreground" />
      <rect x="184" y="150" width="96" height="8" rx="3" fill="currentColor" fillOpacity="0.08" className="text-fd-foreground" />
      <rect x="184" y="166" width="110" height="8" rx="3" fill="currentColor" fillOpacity="0.08" className="text-fd-foreground" />
      <rect x="184" y="188" width="72" height="24" rx="5" fill="var(--home-ok)" opacity="0.85" />
      <text x="220" y="204" textAnchor="middle" fontSize="11" className="fill-fd-background">Pay</text>
    </g>
  );
}

function TerminalWindow() {
  const lines: Array<{ text: string; color?: string; opacity?: number }> = [
    { text: "$ tt http 5173", opacity: 0.9 },
    { text: "✓ tunnel online", color: "var(--home-ok)" },
    { text: "forwarding public traffic", opacity: 0.5 },
    { text: "→ localhost:5173", color: "var(--home-ok)" },
  ];
  return (
    <g>
      <rect
        x="652"
        y="70"
        width="308"
        height="196"
        rx="10"
        fill="var(--home-ok)"
        fillOpacity="0.05"
        stroke="var(--home-ok)"
        strokeOpacity="0.35"
      />
      {/* chrome */}
      <line x1="652" y1="104" x2="960" y2="104" stroke="var(--home-ok)" strokeOpacity="0.25" />
      <circle cx="674" cy="87" r="4" fill="var(--home-ok)" opacity="0.5" />
      <circle cx="690" cy="87" r="4" fill="var(--home-ok)" opacity="0.5" />
      <circle cx="706" cy="87" r="4" fill="var(--home-ok)" opacity="0.5" />
      <text x="806" y="91" textAnchor="middle" fontSize="10" className="fill-fd-muted-foreground">
        tt — bash
      </text>

      {lines.map((l, i) => (
        <text
          key={i}
          x="674"
          y={136 + i * 26}
          fontSize="13"
          fill={l.color ?? "currentColor"}
          fillOpacity={l.color ? 1 : l.opacity ?? 0.9}
          className={l.color ? undefined : "text-fd-foreground"}
        >
          {l.text}
        </text>
      ))}
      {/* caret */}
      <rect x="674" y="228" width="8" height="14" fill="var(--home-ok)" opacity="0.7" />
    </g>
  );
}
