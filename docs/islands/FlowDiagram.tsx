import { useId, type ReactNode } from "react";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";

const REQUEST_PATH = "M175,190 H925";
const RESPONSE_PATH = "M925,222 H175";
const FALLBACK_PATH = "M395,240 V315 H475 V240";
const PACKET_COUNT = 3;
const TRAVEL_TIME = 4.8;

export default function FlowDiagram() {
  const titleId = useId();
  const descriptionId = useId();

  const mountAnimation = (root: SVGSVGElement | null) => {
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(MotionPathPlugin);

    const animations: gsap.core.Animation[] = [];
    const context = gsap.context(() => {
      const animatePackets = (selector: string, path: string) => {
        gsap.utils.toArray<SVGCircleElement>(selector).forEach((packet, index) => {
          const tween = gsap.to(packet, {
            motionPath: { path, alignOrigin: [0.5, 0.5] },
            duration: TRAVEL_TIME,
            ease: "none",
            repeat: -1,
          });
          tween.progress(index / PACKET_COUNT);
          animations.push(tween);
        });
      };

      animatePackets(".tt-request-packet", REQUEST_PATH);
      animatePackets(".tt-response-packet", RESPONSE_PATH);

      const fallbackPacket = root.querySelector<SVGCircleElement>(".tt-fallback-packet");
      if (fallbackPacket) {
        const fallback = gsap
          .timeline({ repeat: -1, repeatDelay: 2.4, delay: 1.2 })
          .set(fallbackPacket, { opacity: 1 })
          .to(fallbackPacket, {
            motionPath: { path: FALLBACK_PATH, alignOrigin: [0.5, 0.5] },
            duration: 1.6,
            ease: "power1.inOut",
          })
          .to(fallbackPacket, { opacity: 0, duration: 0.16 });
        animations.push(fallback);
      }
    }, root);

    let isVisible = true;
    const syncPlayback = () => {
      for (const animation of animations) {
        if (isVisible && !document.hidden) animation.resume();
        else animation.pause();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      isVisible = entry?.isIntersecting ?? false;
      syncPlayback();
    });

    observer.observe(root);
    document.addEventListener("visibilitychange", syncPlayback);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      context.revert();
    };
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background">
      <svg
        ref={mountAnimation}
        viewBox="0 0 1100 430"
        className="block h-auto min-w-190 w-full font-mono"
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>Turbotunnel request architecture</title>
        <desc id={descriptionId}>
          Browser traffic reaches a gateway web server in a Vercel deployment, crosses a WebSocket
          to Turbotunnel, and is forwarded to the local app. Responses return along the same route.
          Vercel Queue provides cross-instance fallback inside the deployment.
        </desc>

        <DeploymentBoundary />
        <Connections />
        <Packets />

        <BrowserNode />
        <GatewayNode />
        <QueueNode />
        <CliNode />
        <LocalAppNode />

        <Legend />
      </svg>
    </div>
  );
}

function DeploymentBoundary() {
  return (
    <g>
      <rect
        x="250"
        y="46"
        width="370"
        height="330"
        rx="12"
        fill="currentColor"
        fillOpacity="0.012"
        stroke="currentColor"
        strokeOpacity="0.18"
        className="text-foreground"
      />
      <path d="M278 68 l8 14 h-16 z" className="fill-foreground" />
      <text x="302" y="81" fontSize="11" letterSpacing="1.4" className="fill-muted-foreground">
        VERCEL DEPLOYMENT
      </text>
    </g>
  );
}

function Connections() {
  return (
    <g fill="none" strokeLinecap="round">
      <g stroke="var(--home-ok)" strokeWidth="1.4" opacity="0.72">
        <path d="M175 190 H300" />
        <path d="M570 190 H700" />
        <path d="M845 190 H925" />
      </g>
      <g stroke="var(--home-response)" strokeWidth="1.4" opacity="0.72">
        <path d="M300 222 H175" />
        <path d="M700 222 H570" />
        <path d="M925 222 H845" />
      </g>

      <g fill="var(--home-ok)">
        <path d="M300 190 l-9 -5 v10 z" />
        <path d="M700 190 l-9 -5 v10 z" />
        <path d="M925 190 l-9 -5 v10 z" />
      </g>
      <g fill="var(--home-response)">
        <path d="M175 222 l9 -5 v10 z" />
        <path d="M570 222 l9 -5 v10 z" />
        <path d="M845 222 l9 -5 v10 z" />
      </g>

      <path
        d={FALLBACK_PATH}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeDasharray="3 5"
        className="text-muted-foreground"
        opacity="0.65"
      />

      <text x="237.5" y="174" textAnchor="middle" fontSize="11" className="fill-muted-foreground">
        HTTP / WS
      </text>
      <text x="635" y="174" textAnchor="middle" fontSize="11" className="fill-muted-foreground">
        WebSocket
      </text>
      <text x="885" y="174" textAnchor="middle" fontSize="11" className="fill-muted-foreground">
        localhost
      </text>
      <text x="435" y="280" textAnchor="middle" fontSize="10" className="fill-muted-foreground">
        cross-instance fallback
      </text>
    </g>
  );
}

function Packets() {
  return (
    <g aria-hidden="true">
      {Array.from({ length: PACKET_COUNT }, (_, index) => (
        <circle
          key={`request-${index}`}
          className="tt-request-packet"
          cx="0"
          cy="0"
          r="4"
          fill="var(--home-ok)"
        />
      ))}
      {Array.from({ length: PACKET_COUNT }, (_, index) => (
        <circle
          key={`response-${index}`}
          className="tt-response-packet"
          cx="0"
          cy="0"
          r="4"
          fill="var(--home-response)"
        />
      ))}
      <circle
        className="tt-fallback-packet"
        cx="0"
        cy="0"
        r="3.5"
        fill="var(--home-queue)"
        opacity="0"
      />
    </g>
  );
}

function BrowserNode() {
  return (
    <Node x={30} y={158} width={145} height={96}>
      <g
        transform="translate(53 193)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        className="text-muted-foreground"
      >
        <circle cx="9" cy="9" r="8" />
        <path d="M1 9 h16 M9 1 c5 5 5 11 0 16 M9 1 c-5 5 -5 11 0 16" />
      </g>
      <text x="88" y="212" fontFamily="sans-serif" fontSize="16" className="fill-foreground">
        Browser
      </text>
    </Node>
  );
}

function GatewayNode() {
  return (
    <Node x={300} y={158} width={270} height={96}>
      <g
        transform="translate(325 192)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-muted-foreground"
      >
        <rect x="7" y="0" width="7" height="7" rx="1" />
        <rect x="0" y="18" width="7" height="7" rx="1" />
        <rect x="14" y="18" width="7" height="7" rx="1" />
        <path d="M10.5 7 v6 M3.5 13 h14 M3.5 13 v5 M17.5 13 v5" />
      </g>
      <text x="367" y="212" fontFamily="sans-serif" fontSize="16" className="fill-foreground">
        Gateway Web Server
      </text>
    </Node>
  );
}

function QueueNode() {
  return (
    <Node x={340} y={300} width={190} height={54} radius={6} tintOpacity={0.055}>
      <g
        transform="translate(361 316)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="text-muted-foreground"
      >
        <ellipse cx="7" cy="3" rx="7" ry="3" />
        <path d="M0 3 v14 c0 4 14 4 14 0 V3 M0 10 c0 4 14 4 14 0" />
      </g>
      <text x="396" y="334" fontFamily="sans-serif" fontSize="15" className="fill-foreground">
        Vercel Queue
      </text>
    </Node>
  );
}

function CliNode() {
  return (
    <Node x={700} y={158} width={145} height={96}>
      <g
        transform="translate(716 195)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        className="text-muted-foreground"
      >
        <path d="M0 0 l8 8 -8 8 M11 16 h9" />
      </g>
      <text x="748" y="212" fontFamily="sans-serif" fontSize="15" className="fill-foreground">
        Turbotunnel
      </text>
    </Node>
  );
}

function LocalAppNode() {
  return (
    <Node x={925} y={158} width={145} height={96}>
      <g
        transform="translate(941 194)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        className="text-muted-foreground"
      >
        <rect x="0" y="0" width="21" height="17" rx="2" />
        <path d="M0 5 h21 M3 2.5 h1 M6 2.5 h1" />
      </g>
      <text x="976" y="212" fontFamily="sans-serif" fontSize="16" className="fill-foreground">
        Local App
      </text>
    </Node>
  );
}

function Node({
  x,
  y,
  width,
  height,
  radius = 6,
  tintOpacity = 0.025,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  tintOpacity?: number;
  children: ReactNode;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={radius}
        fill="var(--home-surface)"
        stroke="currentColor"
        strokeOpacity="0.3"
        className="text-foreground"
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={radius}
        fill="currentColor"
        fillOpacity={tintOpacity}
        className="text-foreground"
      />
      {children}
    </g>
  );
}

function Legend() {
  return (
    <g transform="translate(34 400)">
      <circle cx="4" cy="-4" r="4" fill="var(--home-ok)" />
      <text x="16" y="0" fontSize="11" className="fill-muted-foreground">
        request
      </text>
      <circle cx="104" cy="-4" r="4" fill="var(--home-response)" />
      <text x="116" y="0" fontSize="11" className="fill-muted-foreground">
        response
      </text>
      <circle cx="220" cy="-4" r="4" fill="var(--home-queue)" />
      <text x="232" y="0" fontSize="11" className="fill-muted-foreground">
        fallback
      </text>
    </g>
  );
}
