import { SceneFrame } from "./scene-frame";

/**
 * Domain + slug product demo.
 *
 * Default tunnel domain (from deploy-plan DEFAULT_BASE_DOMAIN):
 *   {slug}-turbotunnel.vercel.app
 *
 * `--slug checkout` → https://checkout-turbotunnel.vercel.app/
 * Custom domains are optional via `tt deploy --domain` and are not the default.
 */
const sessions = [
  {
    slug: "checkout",
    host: "checkout-turbotunnel.vercel.app",
    port: 5173,
    active: true,
  },
  {
    slug: "webhook",
    host: "webhook-turbotunnel.vercel.app",
    port: 3000,
    active: false,
  },
  {
    slug: "demo",
    host: "demo-turbotunnel.vercel.app",
    port: 8080,
    active: false,
  },
] as const;

export function DomainScene() {
  return (
    <SceneFrame label="Session slugs fill the default {slug}-turbotunnel.vercel.app host pattern, producing distinct public URLs">
      <div className="px-3 py-8 sm:px-6 sm:py-11 lg:px-10 lg:py-14">
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-10">
          {/* Pattern card — the real default domain */}
          <div className="home-panel home-panel-raised overflow-hidden">
            <div className="border-b border-fd-border/80 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                  tunnel domain
                </span>
                <span className="font-mono text-[10px] text-fd-muted-foreground">
                  default
                </span>
              </div>
            </div>

            <div className="space-y-5 p-4 sm:p-5">
              <div className="rounded-sm border border-fd-border bg-fd-muted/40 px-3 py-3 font-mono text-[13px] leading-none sm:text-[14px]">
                <span className="home-slug-mark relative inline-flex items-center px-1.5 py-1 text-fd-foreground">
                  {"{slug}"}
                  <span className="home-caret absolute inset-y-1.5 -right-px w-px bg-fd-foreground" />
                </span>
                <span className="text-fd-muted-foreground">-turbotunnel.vercel.app</span>
              </div>

              <div className="space-y-2 font-mono text-[11px]">
                <Row label="from" value="tt deploy" />
                <Row label="project" value="{slug}-turbotunnel" />
                <Row label="host" value="{slug}-turbotunnel.vercel.app" />
              </div>

              <div className="border-t border-fd-border/70 pt-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
                  this session
                </div>
                <div className="mt-2 font-mono text-[12px] text-fd-foreground">
                  <span className="text-fd-muted-foreground">$ </span>
                  tt http 5173 --slug checkout
                </div>
                <div className="mt-2 font-mono text-[12px]">
                  <span className="text-fd-muted-foreground">→ </span>
                  <span className="text-fd-foreground">
                    https://checkout-turbotunnel.vercel.app/
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Resolved hosts */}
          <div className="space-y-2">
            <div className="mb-1 flex items-baseline justify-between px-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fd-muted-foreground">
              <span>public hosts</span>
              <span className="normal-case tracking-normal">--slug</span>
            </div>

            {sessions.map((session) => (
              <div
                key={session.slug}
                className={
                  session.active
                    ? "home-panel home-panel-live relative"
                    : "home-panel opacity-75"
                }
              >
                {session.active ? (
                  <div className="absolute inset-y-3 left-0 w-px bg-fd-foreground/70" />
                ) : null}

                <div className="flex items-start gap-3 px-3.5 py-3 sm:items-center sm:px-4">
                  <span
                    className={
                      session.active
                        ? "mt-1.5 size-1.5 shrink-0 rounded-full home-dot-live sm:mt-0"
                        : "mt-1.5 size-1.5 shrink-0 rounded-full bg-fd-border sm:mt-0"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] tracking-tight sm:text-[13px]">
                      <span className="text-fd-foreground">{session.slug}</span>
                      <span className="text-fd-muted-foreground">
                        -turbotunnel.vercel.app
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-fd-muted-foreground">
                      --slug {session.slug}
                      <span className="mx-1.5 opacity-40">·</span>
                      localhost:{session.port}
                    </div>
                  </div>
                  {session.active ? (
                    <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-fd-foreground sm:inline">
                      live
                    </span>
                  ) : null}
                </div>
              </div>
            ))}

            <p className="px-0.5 pt-2 font-mono text-[10px] leading-relaxed text-fd-muted-foreground">
              Custom domains via{" "}
              <span className="text-fd-foreground">tt deploy --domain</span>
              {" · "}
              optional
            </p>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-2">
      <span className="text-fd-muted-foreground">{label}</span>
      <span className="truncate text-fd-foreground">{value}</span>
    </div>
  );
}
