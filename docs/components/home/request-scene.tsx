"use client";

import { useEffect, useRef, useState } from "react";
import { SceneFrame } from "./scene-frame";

/**
 * Request path as a product demo:
 * Browser → Gateway (Vercel) → tt http → localhost
 *
 * Vercel-style: dark panels, labeled directional arrows, animated packets.
 * Green = request path, blue = response path.
 */
export function RequestScene() {
  return (
    <SceneFrame label="A browser request to checkout-turbotunnel.vercel.app reaches the gateway, travels over the WebSocket relay opened by tt http, and is proxied to localhost:5173">
      <div className="relative overflow-hidden px-4 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
        <FlowDiagram />
        {/* Legend */}
        <div className="mt-6 flex items-center gap-5 font-mono text-[10px] text-fd-muted-foreground" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-6 bg-[var(--home-ok)]" />
            request
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-6 bg-[var(--home-response)]" />
            response
          </span>
        </div>
      </div>
    </SceneFrame>
  );
}

function FlowDiagram() {
  return (
    <div className="relative w-full">
      {/* Nodes row */}
      <div className="grid grid-cols-4 gap-3 sm:gap-4">
        <Node
          icon={<BrowserIcon />}
          label="Browser"
          sublabel="checkout-turbotunnel.vercel.app"
        />
        <Node
          icon={<GatewayIcon />}
          label="Gateway"
          sublabel="Vercel Deployment"
          highlighted
        />
        <Node
          icon={<TerminalIcon />}
          label="tt http"
          sublabel="localhost relay"
        />
        <Node
          icon={<AppIcon />}
          label="Local App"
          sublabel=":5173"
        />
      </div>

      {/* Arrow rows */}
      <div className="mt-3 space-y-2">
        {/* Request arrows */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Arrow label="HTTP / WS" tone="request" delay={0} />
          <Arrow label="WebSocket" tone="request" delay={0.4} />
          <Arrow label="localhost" tone="request" delay={0.8} />
        </div>
        {/* Response arrows */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Arrow label="" tone="response" reverse delay={1.3} />
          <Arrow label="" tone="response" reverse delay={0.9} />
          <Arrow label="" tone="response" reverse delay={0.5} />
        </div>
      </div>
    </div>
  );
}

function Node({
  icon,
  label,
  sublabel,
  highlighted,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-[2px] border p-2.5 sm:p-3 ${
        highlighted
          ? "border-[color-mix(in_oklch,var(--home-live)_20%,var(--home-edge))] bg-[color-mix(in_oklch,var(--home-live)_4%,var(--color-fd-background))] shadow-[0_0_0_1px_var(--home-live-soft),0_8px_24px_var(--home-live-soft)]"
          : "border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_90%,transparent)]"
      }`}
    >
      <div className="flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--home-edge)] bg-[color-mix(in_oklch,var(--home-surface)_80%,transparent)] text-fd-muted-foreground">
        {icon}
      </div>
      <div>
        <div className="font-mono text-[11px] font-medium text-fd-foreground">{label}</div>
        {sublabel && (
          <div className="mt-0.5 font-mono text-[9px] leading-tight text-fd-muted-foreground hidden sm:block">
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}

function Arrow({
  label,
  tone,
  reverse,
  delay,
}: {
  label: string;
  tone: "request" | "response";
  reverse?: boolean;
  delay?: number;
}) {
  const color = tone === "request" ? "var(--home-ok)" : "var(--home-response)";
  const animClass = tone === "request" ? "home-packet-req" : "home-packet-res";
  const delayStyle = { animationDelay: `${delay ?? 0}s` };

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative h-px w-full"
        style={{ background: color, opacity: 0.6 }}
        aria-hidden
      >
        {/* Arrowhead */}
        <Arrowhead color={color} reverse={reverse} />
        {/* Traveling packet */}
        <span
          className={`home-packet-line ${animClass} ${reverse ? "home-packet-line-rev" : ""}`}
          style={delayStyle}
        />
      </div>
      {label ? (
        <span className="font-mono text-[9px] text-fd-muted-foreground">{label}</span>
      ) : null}
    </div>
  );
}

function Arrowhead({ color, reverse }: { color: string; reverse?: boolean }) {
  return (
    <svg
      width="6"
      height="6"
      viewBox="0 0 6 6"
      fill="none"
      aria-hidden
      className="absolute top-1/2 -translate-y-1/2"
      style={{ [reverse ? "left" : "right"]: -1, transform: `translateY(-50%) ${reverse ? "rotate(180deg)" : ""}` }}
    >
      <path d="M0 0L6 3L0 6Z" fill={color} opacity={0.8} />
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

function GatewayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="4" width="12" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <rect x="1" y="7.5" width="12" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1" />
      <circle cx="3" cy="5.25" r="0.75" fill="currentColor" />
      <circle cx="3" cy="8.75" r="0.75" fill="currentColor" />
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
