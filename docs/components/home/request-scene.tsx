import { Beam, SceneFrame } from "./scene-frame";

/**
 * Request path as a product demo:
 * public host → Vercel gateway → WSS relay held by `tt http` → localhost.
 *
 * Default public host shape from DEFAULT_BASE_DOMAIN:
 *   {slug}-turbotunnel.vercel.app
 */
export function RequestScene() {
  return (
    <SceneFrame label="A browser request to checkout-turbotunnel.vercel.app reaches the gateway, travels over the WebSocket relay opened by tt http, and is proxied to localhost:5173">
      <div className="px-3 py-8 space-y-12 sm:px-6 sm:py-11 lg:px-10 lg:py-14">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[1.15fr_0.95fr] lg:gap-8 lg:items-stretch">
          {/* Public side: browser hitting the real default host */}
          <div className="home-panel home-panel-raised flex min-h-0 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-fd-border/80 px-3 py-2.5">
              <div className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-fd-border" />
                <span className="size-1.5 rounded-full bg-fd-border" />
                <span className="size-1.5 rounded-full bg-fd-border" />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-sm bg-fd-muted/70 px-2.5 py-1.5 font-mono text-[11px] leading-none">
                <LockIcon />
                <span className="truncate text-fd-foreground">checkout-turbotunnel.vercel.app</span>
                <span className="hidden text-fd-muted-foreground sm:inline">/api/cart</span>
              </div>
            </div>

            <div className="relative flex flex-1 flex-col justify-between gap-6 p-4 sm:p-5">
              <div className="space-y-2.5">
                <div className="h-2 w-24 rounded-sm bg-fd-foreground/10" />
                <div className="h-2 w-full max-w-[16rem] rounded-sm bg-fd-foreground/[0.06]" />
                <div className="h-2 w-full max-w-[12rem] rounded-sm bg-fd-foreground/[0.06]" />
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="h-14 rounded-sm bg-fd-muted/80" />
                  <div className="h-14 rounded-sm bg-fd-muted/60" />
                  <div className="h-14 rounded-sm bg-fd-muted/40" />
                </div>
              </div>

              <div className="home-panel flex items-center gap-3 px-3 py-2.5">
                <span className="size-1.5 shrink-0 rounded-full home-dot-live" />
                <div className="min-w-0 font-mono text-[10px] leading-relaxed">
                  <div className="text-fd-foreground">GET /api/cart</div>
                  <div className="text-fd-muted-foreground">
                    host · checkout-turbotunnel.vercel.app
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Local side: CLI + app, with path through gateway */}
          <div className="flex min-h-0 flex-col gap-3">
            {/* Gateway strip */}
            <div className="home-panel home-panel-live px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <VercelMark />
                  <span className="font-mono text-[11px] text-fd-foreground">gateway</span>
                </div>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                  your vercel project
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Beam className="flex-1" />
                <span className="shrink-0 font-mono text-[9px] text-fd-muted-foreground">wss</span>
              </div>
            </div>

            {/* Terminal — matches CLI Starting tunnel output */}
            <div className="home-panel home-panel-raised flex-1 overflow-hidden">
              <div className="flex items-center justify-between border-b border-fd-border/80 px-3 py-2">
                <span className="font-mono text-[10px] text-fd-muted-foreground">
                  tt http 5173 --slug checkout
                </span>
              </div>
              <pre className="overflow-x-auto p-3.5 font-mono text-[11px] leading-[1.7] sm:text-[12px]">
                <code>
                  <span className="block font-medium text-fd-foreground">Starting tunnel</span>
                  <span className="mt-2 block text-fd-muted-foreground">
                    {"  "}Public URL{"       "}
                    <span className="text-fd-foreground">
                      https://checkout-turbotunnel.vercel.app/
                    </span>
                  </span>
                  <span className="block text-fd-muted-foreground">
                    {"  "}Local app{"        "}
                    <span className="text-fd-foreground">http://localhost:5173</span>
                  </span>
                  <span className="mt-2 block">
                    <span className="text-[var(--home-ok)]">✓</span>
                    <span className="text-fd-muted-foreground">
                      {"  "}Tunnel{"          "}
                    </span>
                    <span className="text-fd-foreground">ready</span>
                  </span>
                </code>
              </pre>
            </div>

            {/* Localhost app */}
            <div className="home-panel flex items-center gap-3 px-3.5 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-fd-border bg-fd-muted font-mono text-[10px] text-fd-muted-foreground">
                :5173
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12px] text-fd-foreground">localhost</div>
                <div className="font-mono text-[10px] text-fd-muted-foreground">
                  request proxied by tt http
                </div>
              </div>
              <span className="size-1.5 shrink-0 rounded-full home-dot-live" />
            </div>
          </div>
        </div>

        {/* Mobile / footer path legend — visual only, sparse */}
        <div
          className="flex flex-row justify-center max-w-5xl items-center gap-2 px-1 font-mono text-[10px] text-fd-muted-foreground"
          aria-hidden
        >
          <span className="text-fd-foreground">browser</span>
          <Beam className="max-w-16 flex-1 sm:max-w-24" tone="dim" />
          <span>gateway</span>
          <Beam className="max-w-16 flex-1 sm:max-w-24" />
          <span className="text-fd-foreground">tt http</span>
          <Beam className="max-w-12 flex-1 sm:max-w-16" tone="dim" />
          <span>:5173</span>
        </div>
      </div>
    </SceneFrame>
  );
}

function LockIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className="shrink-0 text-fd-muted-foreground"
    >
      <rect x="2" y="4.5" width="6" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <path d="M3.25 4.5V3.25a1.75 1.75 0 0 1 3.5 0V4.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function VercelMark() {
  return (
    <svg width="10" height="9" viewBox="0 0 10 9" fill="none" aria-hidden>
      <path d="M5 0.5L9.5 8.5H0.5L5 0.5Z" fill="currentColor" className="text-fd-foreground" />
    </svg>
  );
}
