"use client";

import { SceneFrame } from "./scene-frame";

/**
 * Cross-instance routing product demo.
 *
 * Vercel may run multiple gateway instances. A public request can land on an
 * instance that does not hold the tt http WebSocket. Vercel Queue carries the
 * request to the instance that does; the response returns along the same path.
 *
 * Layout (Vercel-style):
 *   [Browser] ──→ [Instance B (no socket)] ···→ [Vercel Queue] ···→ [Instance A (holds WSS)] ──→ [tt http] ──→ [:5173]
 */
export function FallbackScene() {
  return (
    <SceneFrame label="Request lands on gateway instance B with no tunnel socket; Vercel Queue forwards it to instance A, which holds the tt http connection to localhost">
      <div className="relative overflow-hidden px-4 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
        {/* Main flow row */}
        <div className="flex items-center gap-0 overflow-x-auto pb-2">
          {/* Browser */}
          <FlowNode
            icon={<BrowserIcon />}
            label="Browser"
            sublabel="incoming request"
          />
          <FlowArrow label="HTTP" tone="request" delay={0} />

          {/* Vercel Deployment box wrapping both instances */}
          <div className="relative shrink-0">
            <div className="rounded-[2px] border border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_85%,transparent)]">
              <div className="flex items-center gap-2 border-b border-[var(--home-edge)] px-3 py-2">
                <VercelMark />
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                  Vercel Deployment
                </span>
              </div>
              <div className="p-3">
                <div className="flex items-stretch gap-3">
                  {/* Instance B */}
                  <InstanceBox
                    name="Instance B"
                    note="request arrives"
                    hasSocket={false}
                  />

                  {/* Queue connector */}
                  <div className="flex flex-col items-center justify-center gap-1.5 w-28 shrink-0">
                    <div className="w-full rounded-[2px] border px-2 py-1.5 text-center"
                      style={{
                        borderColor: `color-mix(in oklch, var(--home-queue) 28%, var(--home-edge))`,
                        background: `color-mix(in oklch, var(--home-queue) 6%, var(--color-fd-background))`,
                      }}
                    >
                      <div className="flex items-center justify-center gap-1.5">
                        <span className="size-1.5 rounded-full home-dot-queue" />
                        <span className="font-mono text-[10px] text-fd-foreground">
                          Vercel Queue
                        </span>
                      </div>
                    </div>
                    {/* Queue arrow with animation */}
                    <QueueArrow />
                    <span className="font-mono text-[9px] text-fd-muted-foreground text-center leading-tight">
                      cross-instance<br />fallback
                    </span>
                  </div>

                  {/* Instance A */}
                  <InstanceBox
                    name="Instance A"
                    note="holds wss"
                    hasSocket
                  />
                </div>
              </div>
            </div>
          </div>

          <FlowArrow label="WSS" tone="request" delay={1.2} />

          {/* tt http */}
          <FlowNode
            icon={<TerminalIcon />}
            label="tt http"
            sublabel="relay process"
          />
          <FlowArrow label="localhost" tone="request" delay={1.6} />

          {/* Local app */}
          <FlowNode
            icon={<AppIcon />}
            label=":5173"
            sublabel="local app"
          />
        </div>

        {/* Legend */}
        <div className="mt-6 flex items-center gap-5 font-mono text-[10px] text-fd-muted-foreground" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-6 bg-[var(--home-ok)]" />
            request
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-px w-6"
              style={{ background: "var(--home-queue)" }}
            />
            queue fallback
          </span>
        </div>
      </div>
    </SceneFrame>
  );
}

function FlowNode({
  icon,
  label,
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-2 rounded-[2px] border border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_88%,transparent)] px-3 py-2.5 text-center">
      <div className="flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_80%,transparent)] text-fd-muted-foreground">
        {icon}
      </div>
      <div>
        <div className="font-mono text-[11px] font-medium text-fd-foreground">{label}</div>
        {sublabel && (
          <div className="font-mono text-[9px] text-fd-muted-foreground hidden sm:block">
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowArrow({
  label,
  tone,
  delay,
}: {
  label: string;
  tone: "request" | "queue";
  delay?: number;
}) {
  const color = tone === "request" ? "var(--home-ok)" : "var(--home-queue)";
  const animClass = tone === "request" ? "home-packet-req" : "home-packet-queue-line";

  return (
    <div className="flex shrink-0 flex-col items-center gap-1 w-10 sm:w-14">
      <div className="relative h-px w-full" style={{ background: color, opacity: 0.65 }} aria-hidden>
        <Arrowhead color={color} />
        <span
          className={`home-packet-line ${animClass}`}
          style={{ animationDelay: `${delay ?? 0}s` }}
        />
      </div>
      {label && (
        <span className="font-mono text-[9px] text-fd-muted-foreground">{label}</span>
      )}
    </div>
  );
}

function Arrowhead({ color }: { color: string }) {
  return (
    <svg
      width="6"
      height="6"
      viewBox="0 0 6 6"
      fill="none"
      aria-hidden
      className="absolute top-1/2 right-[-1px]"
      style={{ transform: "translateY(-50%)" }}
    >
      <path d="M0 0L6 3L0 6Z" fill={color} opacity={0.85} />
    </svg>
  );
}

function QueueArrow() {
  return (
    <div className="relative h-px w-full" style={{ background: "var(--home-queue)", opacity: 0.7 }} aria-hidden>
      <svg
        width="6"
        height="6"
        viewBox="0 0 6 6"
        fill="none"
        aria-hidden
        className="absolute top-1/2 right-[-1px]"
        style={{ transform: "translateY(-50%)" }}
      >
        <path d="M0 0L6 3L0 6Z" fill="var(--home-queue)" opacity={0.85} />
      </svg>
      <span
        className="home-packet-line home-packet-queue-line"
        style={{ animationDelay: "0.6s" }}
      />
    </div>
  );
}

function InstanceBox({
  name,
  note,
  hasSocket,
}: {
  name: string;
  note: string;
  hasSocket: boolean;
}) {
  return (
    <div
      className={`flex min-w-[100px] flex-col gap-2 rounded-[2px] border p-2.5 ${
        hasSocket
          ? "border-[color-mix(in_oklch,var(--home-live)_22%,var(--home-edge))] bg-[color-mix(in_oklch,var(--home-live)_5%,var(--color-fd-background))]"
          : "border-dashed border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_50%,transparent)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-fd-foreground">{name}</span>
        {hasSocket ? (
          <span className="flex items-center gap-1 font-mono text-[9px] text-fd-foreground">
            <span className="size-1 rounded-full home-dot-live" />
            wss
          </span>
        ) : (
          <span className="font-mono text-[9px] text-fd-muted-foreground">no socket</span>
        )}
      </div>
      <div className="space-y-1">
        <div
          className={`h-1 w-full rounded-[1px] ${
            hasSocket ? "bg-fd-foreground/15" : "bg-fd-border/50"
          }`}
        />
        <div
          className={`h-1 w-3/5 rounded-[1px] ${
            hasSocket ? "bg-fd-foreground/10" : "bg-fd-border/30"
          }`}
        />
      </div>
      <div className="font-mono text-[9px] text-fd-muted-foreground">{note}</div>
    </div>
  );
}

function VercelMark() {
  return (
    <svg width="9" height="8" viewBox="0 0 10 9" fill="none" aria-hidden>
      <path d="M5 0.5L9.5 8.5H0.5L5 0.5Z" fill="currentColor" className="text-fd-foreground" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1" />
      <path d="M1 7h12M7 1c-2 2-2 8 0 12M7 1c2 2 2 8 0 12" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="2" width="12" height="10" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <path d="M3.5 5.5L5.5 7L3.5 8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 8.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function AppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="1" width="12" height="12" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <path d="M1 4h12" stroke="currentColor" strokeWidth="1" />
      <circle cx="3.5" cy="2.5" r="0.5" fill="currentColor" />
      <circle cx="5.5" cy="2.5" r="0.5" fill="currentColor" />
    </svg>
  );
}
