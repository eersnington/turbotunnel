import { Beam, SceneFrame } from "./scene-frame";

/**
 * Cross-instance routing product demo.
 *
 * Vercel may run multiple gateway instances. A public request can land on an
 * instance that does not hold the tt http WebSocket. Vercel Queue carries the
 * request to the instance that does; the response returns along the same path.
 */
export function FallbackScene() {
  return (
    <SceneFrame label="Request lands on gateway instance B with no tunnel socket; Vercel Queue forwards it to instance A, which holds the tt http connection to localhost">
      <div className="px-3 py-8 sm:px-6 sm:py-11 lg:px-10 lg:py-14">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-3">
          {/* Ingress */}
          <div className="home-panel home-panel-raised mx-auto w-full max-w-[200px] shrink-0 lg:mx-0 lg:w-[148px] xl:w-[160px]">
            <div className="flex items-center gap-1 border-b border-fd-border/80 px-2.5 py-2">
              <span className="size-1.5 rounded-full bg-fd-border" />
              <span className="size-1.5 rounded-full bg-fd-border" />
              <span className="size-1.5 rounded-full bg-fd-border" />
            </div>
            <div className="space-y-2 p-2.5">
              <div className="rounded-sm bg-fd-muted/70 px-2 py-1.5 font-mono text-[9px] text-fd-muted-foreground">
                GET /api/cart
              </div>
              <div className="truncate font-mono text-[9px] text-fd-foreground">
                checkout-turbotunnel…
              </div>
              <div className="h-1 w-3/4 rounded-sm bg-fd-foreground/[0.07]" />
              <div className="h-1 w-1/2 rounded-sm bg-fd-foreground/[0.05]" />
            </div>
          </div>

          <div className="flex items-center justify-center lg:w-8 xl:w-10" aria-hidden>
            <Beam tone="dim" className="w-10 lg:w-full" />
          </div>

          {/* Deployment cluster */}
          <div className="home-panel min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-fd-border/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <VercelMark />
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                  vercel deployment
                </span>
              </div>
              <span className="font-mono text-[9px] text-fd-muted-foreground">
                fluid compute
              </span>
            </div>

            <div className="grid gap-3 p-3 sm:grid-cols-2 sm:gap-3 sm:p-4">
              {/* Instance B — request lands here, no local client */}
              <div className="relative rounded-sm border border-dashed border-fd-border bg-fd-background/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-fd-foreground">
                    instance B
                  </span>
                  <span className="font-mono text-[9px] text-fd-muted-foreground">
                    no socket
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1 rounded-sm bg-fd-border/70" />
                  <div className="h-1 w-3/5 rounded-sm bg-fd-border/40" />
                </div>
                <div className="mt-3 font-mono text-[9px] leading-relaxed text-fd-muted-foreground">
                  public request arrives here
                </div>
              </div>

              {/* Instance A — holds the local-client WSS */}
              <div className="home-panel-live relative rounded-sm border border-fd-border bg-fd-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-fd-foreground">
                    instance A
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[9px] text-fd-foreground">
                    <span className="size-1 rounded-full home-dot-live" />
                    holds wss
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1 rounded-sm bg-fd-foreground/15" />
                  <div className="h-1 w-4/5 rounded-sm bg-fd-foreground/10" />
                </div>
                <div className="mt-3 font-mono text-[9px] leading-relaxed text-fd-muted-foreground">
                  local-client registered
                </div>
              </div>
            </div>

            {/* Queue — amber is the only non-mono accent, for fallback path */}
            <div className="px-3 pb-3 sm:px-4 sm:pb-4">
              <div
                className="relative overflow-hidden rounded-sm px-3 py-2.5"
                style={{
                  border: "1px solid color-mix(in oklch, var(--home-queue) 28%, var(--home-edge))",
                  background:
                    "color-mix(in oklch, var(--home-queue) 6%, var(--color-fd-background))",
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full home-dot-queue" />
                    <span className="font-mono text-[11px] text-fd-foreground">
                      Vercel Queue
                    </span>
                  </div>
                  <span
                    className="font-mono text-[9px] uppercase tracking-[0.14em]"
                    style={{ color: "var(--home-queue)" }}
                  >
                    B → A
                  </span>
                </div>
                <div className="relative mt-2.5 h-px">
                  <Beam tone="queue" />
                </div>
                <div className="mt-2 font-mono text-[9px] text-fd-muted-foreground">
                  cross-instance fallback · region iad1
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 lg:w-12 lg:flex-col xl:w-14" aria-hidden>
            <Beam className="w-12 lg:w-full" />
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fd-muted-foreground">
              wss
            </span>
          </div>

          {/* Egress: tt http + localhost */}
          <div className="mx-auto w-full max-w-[200px] shrink-0 space-y-2 lg:mx-0 lg:w-[148px] xl:w-[160px]">
            <div className="home-panel home-panel-raised overflow-hidden">
              <div className="border-b border-fd-border/80 px-3 py-2 font-mono text-[10px] text-fd-muted-foreground">
                tt http
              </div>
              <div className="space-y-1 px-3 py-2.5 font-mono text-[10px]">
                <div className="flex items-center gap-1.5 text-fd-foreground">
                  <span className="text-[var(--home-ok)]">✓</span>
                  connected
                </div>
                <div className="text-fd-muted-foreground">pool · 2 sockets</div>
              </div>
            </div>
            <div className="home-panel flex items-center gap-2 px-3 py-2.5">
              <span className="size-1.5 rounded-full home-dot-live" />
              <span className="font-mono text-[11px] text-fd-foreground">
                localhost:5173
              </span>
            </div>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

function VercelMark() {
  return (
    <svg width="9" height="8" viewBox="0 0 10 9" fill="none" aria-hidden>
      <path d="M5 0.5L9.5 8.5H0.5L5 0.5Z" fill="currentColor" className="text-fd-foreground" />
    </svg>
  );
}
