"use client";

import { SceneFrame } from "./scene-frame";

/**
 * Domain + slug product demo.
 * Shows the slug → URL mapping with animated connection lines.
 */
const sessions = [
  { slug: "checkout", port: 5173, active: true },
  { slug: "webhook", port: 3000, active: false },
  { slug: "demo", port: 8080, active: false },
] as const;

export function DomainScene() {
  return (
    <SceneFrame label="Session slugs fill the default {slug}-turbotunnel.vercel.app host pattern, producing distinct public URLs">
      <div className="relative overflow-hidden px-4 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-0">
            {/* Left: slugs */}
            <div className="space-y-2">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                your slug
              </div>
              {sessions.map((s) => (
                <SlugPill key={s.slug} slug={s.slug} port={s.port} active={s.active} />
              ))}
            </div>

            {/* Center: animated SVG connections */}
            <div className="relative hidden lg:flex lg:w-48 xl:w-64" aria-hidden>
              <ConnectionSVG />
            </div>

            {/* Right: public URLs */}
            <div className="space-y-2">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                public url
              </div>
              {sessions.map((s) => (
                <UrlCard key={s.slug} slug={s.slug} active={s.active} />
              ))}
            </div>
          </div>

          {/* Template formula */}
          <div className="mt-8 rounded-[2px] border border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_80%,transparent)] px-4 py-3">
            <div className="flex items-center gap-3 font-mono text-[11px]">
              <span className="text-fd-muted-foreground">pattern</span>
              <span className="text-fd-muted-foreground mx-1">→</span>
              <span className="text-fd-muted-foreground">
                <span className="home-slug-mark relative inline-flex items-center rounded-[2px] px-1 py-0.5 text-fd-foreground">
                  {"{slug}"}
                  <span className="home-caret absolute inset-y-1 -right-px w-px bg-fd-foreground" />
                </span>
                -turbotunnel.vercel.app
              </span>
            </div>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

function SlugPill({
  slug,
  port,
  active,
}: {
  slug: string;
  port: number;
  active: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-[2px] border px-3 py-2.5 ${
        active
          ? "border-[color-mix(in_oklch,var(--home-live)_22%,var(--home-edge))] bg-[color-mix(in_oklch,var(--home-live)_5%,var(--color-fd-background))] shadow-[0_0_0_1px_var(--home-live-soft)]"
          : "border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_88%,transparent)] opacity-60"
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          active ? "home-dot-live" : "bg-fd-border"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] font-medium text-fd-foreground">
          --slug {slug}
        </div>
        <div className="font-mono text-[10px] text-fd-muted-foreground">
          localhost:{port}
        </div>
      </div>
      {active && (
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-fd-foreground">
          live
        </span>
      )}
    </div>
  );
}

function UrlCard({ slug, active }: { slug: string; active: boolean }) {
  return (
    <div
      className={`rounded-[2px] border px-3 py-2.5 ${
        active
          ? "border-[color-mix(in_oklch,var(--home-live)_22%,var(--home-edge))] bg-[color-mix(in_oklch,var(--home-live)_5%,var(--color-fd-background))]"
          : "border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_88%,transparent)] opacity-60"
      }`}
    >
      <div className="min-w-0 font-mono text-[11px] sm:text-[12px]">
        <span className={active ? "text-fd-foreground" : "text-fd-muted-foreground"}>
          {slug}
        </span>
        <span className="text-fd-muted-foreground">-turbotunnel.vercel.app</span>
      </div>
    </div>
  );
}

/**
 * SVG with 3 horizontal lines connecting left slugs to right URLs.
 * The active (first) line has an animated traveling dot.
 */
function ConnectionSVG() {
  // 3 rows, each ~46px tall with 8px gap
  const rowH = 46;
  const gap = 8;
  const totalH = 3 * rowH + 2 * gap;
  const w = 200;

  const ys = [rowH / 2, rowH + gap + rowH / 2, 2 * (rowH + gap) + rowH / 2];

  return (
    <svg
      width={w}
      height={totalH}
      viewBox={`0 0 ${w} ${totalH}`}
      fill="none"
      className="w-full"
    >
      {ys.map((y, i) => {
        const isActive = i === 0;
        const color = isActive ? "var(--home-ok)" : "var(--home-edge)";
        const opacity = isActive ? 0.8 : 0.5;

        return (
          <g key={i}>
            <line
              x1={0}
              y1={y}
              x2={w}
              y2={y}
              stroke={color}
              strokeWidth={isActive ? 1.5 : 1}
              strokeOpacity={opacity}
              strokeDasharray={isActive ? "none" : "3 3"}
            />
            {/* Arrowhead */}
            <polygon
              points={`${w - 6},${y - 3} ${w},${y} ${w - 6},${y + 3}`}
              fill={color}
              fillOpacity={opacity}
            />
            {isActive && (
              <circle r="3" fill="var(--home-ok)">
                <animateMotion
                  dur="2.4s"
                  repeatCount="indefinite"
                  path={`M0,${y} L${w - 8},${y}`}
                  begin="0s"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.08;0.92;1"
                  dur="2.4s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}
