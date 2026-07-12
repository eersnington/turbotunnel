"use client";

import { Check, Copy } from "lucide-react";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { cn } from "@/lib/cn";

const command = "npm i -g turbotunnel";

export function InstallCommand({ className }: { className?: string }) {
  const [copied, onClick] = useCopyButton(() => {
    void navigator.clipboard.writeText(command);
  });

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy install command"}
      className={cn(
        "inline-flex h-11 items-center gap-2 rounded-md border border-fd-border bg-fd-card px-5 font-mono text-sm transition-colors hover:bg-fd-muted",
        className,
      )}
    >
      <span className="text-fd-muted-foreground">$</span>
      {command}
      {copied ? (
        <Check className="size-3.5 text-fd-muted-foreground" />
      ) : (
        <Copy className="size-3.5 text-fd-muted-foreground" />
      )}
    </button>
  );
}
