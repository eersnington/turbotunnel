import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function SceneFrame({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "relative overflow-hidden rounded-md border border-fd-border bg-fd-background",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Horizontal path with an optional traveling packet. */
export function Beam({
  tone = "live",
  className,
}: {
  tone?: "live" | "queue" | "dim";
  className?: string;
}) {
  return (
    <div
      className={cn("relative h-px w-full min-w-8 overflow-visible", className)}
      aria-hidden
    >
      <div
        className={cn(
          "absolute inset-0",
          tone === "queue"
            ? "bg-[var(--home-queue)]"
            : tone === "dim"
              ? "bg-fd-border"
              : "bg-fd-foreground/45",
        )}
      />
      {tone !== "dim" ? (
        <span
          className={cn("home-packet", tone === "queue" && "home-packet-queue")}
        />
      ) : (
        <span className="home-packet home-packet-dim" />
      )}
    </div>
  );
}
