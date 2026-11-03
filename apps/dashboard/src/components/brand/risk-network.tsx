"use client";

import { useState } from "react";
import {
  BookOpenCheck,
  FileCheck2,
  Landmark,
  ListChecks,
  Pause,
  Play,
  ScanSearch,
  Users,
  Webhook
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NetworkKind = "core" | "record" | "risk" | "tech" | "person";

export type NetworkNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  kind?: NetworkKind;
  meta?: string;
};

export type NetworkLink = {
  from: string;
  to: string;
  tone?: "mint" | "amber";
};

export const sampleNetwork: { nodes: NetworkNode[]; links: NetworkLink[] } = {
  nodes: [
    { id: "customer", label: "Customer", x: 92, y: 150, kind: "person", meta: "cus_…71" },
    { id: "collection", label: "Collection", x: 288, y: 128, kind: "record", meta: "COL-2048" },
    { id: "risk", label: "Risk assessment", x: 288, y: 380, kind: "risk", meta: "score 78" },
    { id: "approval", label: "Approval", x: 500, y: 112, kind: "record", meta: "1 of 2" },
    { id: "ledger", label: "Ledger entry", x: 560, y: 300, kind: "core", meta: "double-entry" },
    { id: "statement", label: "Statement line", x: 812, y: 150, kind: "tech", meta: "Bank-REF-17" },
    { id: "webhook", label: "Webhook delivery", x: 820, y: 392, kind: "tech", meta: "signed" },
    { id: "account", label: "Account", x: 92, y: 388, kind: "person", meta: "RWF wallet" }
  ],
  links: [
    { from: "customer", to: "collection" },
    { from: "account", to: "risk" },
    { from: "collection", to: "risk", tone: "amber" },
    { from: "collection", to: "approval", tone: "amber" },
    { from: "collection", to: "ledger" },
    { from: "risk", to: "ledger", tone: "amber" },
    { from: "approval", to: "ledger" },
    { from: "ledger", to: "statement" },
    { from: "ledger", to: "webhook", tone: "amber" }
  ]
};

const icons = {
  core: BookOpenCheck,
  record: FileCheck2,
  risk: ScanSearch,
  tech: Webhook,
  person: Users
} as const;

type RiskNetworkProps = {
  nodes?: NetworkNode[];
  links?: NetworkLink[];
  className?: string;
  tone?: "dark" | "light";
  animate?: boolean;
  showControls?: boolean;
  compact?: boolean;
  onSelect?: (node: NetworkNode) => void;
  selectedId?: string;
};

export function RiskNetwork({
  nodes = sampleNetwork.nodes,
  links = sampleNetwork.links,
  className,
  tone = "dark",
  animate: animateProp = true,
  showControls = false,
  compact = false,
  onSelect,
  selectedId
}: RiskNetworkProps) {
  const [playing, setPlaying] = useState(animateProp);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dark = tone === "dark";

  const pathFor = (from: NetworkNode, to: NetworkNode) => {
    const mid = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
  };

  return (
    <div className={cn("relative w-full", className)}>
      {showControls && (
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? "Pause network animation" : "Play network animation"}
          className={cn(
            "absolute right-0 top-0 z-10 inline-flex size-8 items-center justify-center rounded-md border transition-colors",
            dark
              ? "border-white/15 bg-white/5 text-on-night-muted hover:text-on-night"
              : "border-border bg-card text-ink-500 hover:text-ink-950"
          )}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
      )}
      <div
        className="relative w-full"
        style={{ aspectRatio: compact ? "1000 / 440" : "1000 / 520" }}
        role="img"
        aria-label="Relationship view of a sample payment: customer, collection, risk assessment, approval, ledger entry, statement line and webhook delivery."
      >
        <svg
          viewBox="0 0 1000 520"
          className="absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="network-link" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={dark ? "#2B3A55" : "#D8D4C9"} />
              <stop offset="100%" stopColor={dark ? "#2B3A55" : "#D8D4C9"} />
            </linearGradient>
          </defs>
          {links.map((link, index) => {
            const from = byId.get(link.from);
            const to = byId.get(link.to);
            if (!from || !to) return null;
            const path = pathFor(from, to);
            return (
              <g key={`${link.from}-${link.to}`}>
                <path
                  d={path}
                  fill="none"
                  stroke={dark ? "rgba(148,166,199,0.34)" : "#CFCBBF"}
                  strokeWidth="1.2"
                  strokeDasharray={link.tone === "amber" ? "3 6" : undefined}
                />
                {playing && (
                  <circle
                    className="risk-dot"
                    r="3.2"
                    fill="#E3A008"
                    key={`${link.from}-${link.to}-${playing}-${index}`}
                  >
                    <animateMotion
                      dur={`${5 + (index % 4)}s`}
                      begin={`${index * 0.55}s`}
                      repeatCount="indefinite"
                      path={path}
                    />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => {
          const Icon = icons[node.kind ?? "record"];
          const core = node.kind === "core";
          const risk = node.kind === "risk";
          const selected = selectedId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect?.(node)}
              tabIndex={onSelect ? 0 : -1}
              className={cn(
                "group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center",
                onSelect ? "cursor-pointer" : "cursor-default"
              )}
              style={{ left: `${(node.x / 1000) * 100}%`, top: `${(node.y / 520) * 100}%` }}
            >
              <span
                className={cn(
                  "relative grid place-items-center rounded-full border transition-transform duration-300 group-hover:-translate-y-0.5",
                  compact ? "size-9" : core ? "size-14" : "size-11",
                  core
                    ? "border-mint/50 bg-mint text-white shadow-[0_0_0_8px_rgba(19,181,140,0.12)]"
                    : risk
                      ? dark
                        ? "border-amber-bright/40 bg-[#231d10] text-amber-bright"
                        : "border-amber/30 bg-amber-soft text-amber"
                      : dark
                        ? "border-white/15 bg-night-raised text-mint"
                        : "border-border bg-card text-ink-800",
                  selected && "ring-2 ring-primary ring-offset-2 ring-offset-transparent"
                )}
                style={
                  core
                    ? { animation: playing ? "node-breathe 4.4s ease-in-out infinite" : undefined }
                    : undefined
                }
              >
                <Icon className={compact ? "size-3.5" : core ? "size-5" : "size-4"} />
              </span>
              {!compact && (
                <span className="max-w-[116px]">
                  <span
                    className={cn(
                      "block text-[11.5px] font-medium leading-tight",
                      dark ? "text-on-night" : "text-ink-700"
                    )}
                  >
                    {node.label}
                  </span>
                  {node.meta && (
                    <span
                      className={cn(
                        "mt-0.5 block font-mono text-[9.5px] leading-tight",
                        dark ? "text-on-night-muted/70" : "text-ink-400"
                      )}
                    >
                      {node.meta}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NetworkLegend({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const items = [
    { color: "bg-mint", label: "Ledger record" },
    { color: "bg-amber-bright", label: "Signal travelling" },
    { color: "bg-primary", label: "Needs a decision" }
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map((item) => (
        <li
          key={item.label}
          className={cn(
            "flex items-center gap-2 text-[11px]",
            tone === "dark" ? "text-on-night-muted" : "text-ink-500"
          )}
        >
          <span className={`size-1.5 rounded-full ${item.color}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
