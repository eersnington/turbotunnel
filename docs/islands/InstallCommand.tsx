import { useState } from "react";

const command = "npm i -g turbotunnel";

type CopyState = "idle" | "copied" | "failed";

export default function InstallCommand() {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const label =
    copyState === "copied"
      ? "Install command copied"
      : copyState === "failed"
        ? "Copy failed. Select the install command manually."
        : "Copy install command";

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={copyState === "failed" ? label : undefined}
      className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-background px-5 font-mono text-sm transition-colors hover:bg-muted"
    >
      <span className="text-muted-foreground">$</span>
      {command}
      {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}
