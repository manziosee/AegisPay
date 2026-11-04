"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Reveal } from "./reveal";
import { pillars } from "@/lib/marketing";
import { StatusBadge } from "@/components/data/status-badge";
import { cn } from "@/lib/utils";

function PillarVisual({ id }: { id: string }) {
  if (id === "ledger") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] text-ink-400">jrn_2b8e41</span>
          <StatusBadge status="completed" label="Balanced" />
        </div>
        <div className="mt-3 divide-y divide-border border-y border-border">
          <div className="flex items-center justify-between py-2.5 text-[12px]">
            <span className="text-ink-500">Debit · sandbox clearing</span>
            <span className="font-mono text-ink-800">RWF 4,200</span>
          </div>
          <div className="flex items-center justify-between py-2.5 text-[12px]">
            <span className="text-ink-500">Credit · RWF wallet</span>
            <span className="font-mono text-ink-800">RWF 4,200</span>
          </div>
        </div>
        <p className="mt-3 font-mono text-[10.5px] text-ink-400">
          reference_type: collection · reference_id: col_8f3a…
        </p>
      </div>
    );
  }

  if (id === "intelligence") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-end justify-between">
          <div>
            <span className="font-mono text-[10.5px] text-ink-400">risk_score</span>
            <p className="mt-1 text-[32px] font-semibold leading-none tracking-[-0.04em] text-ink-950">
              78
            </p>
          </div>
          <StatusBadge status="review" label="Review" />
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper-muted">
          <div className="h-full w-[78%] rounded-full bg-amber-bright" />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-[11.5px]">
          <div>
            <dt className="text-ink-400">Level</dt>
            <dd className="mt-0.5 text-ink-800">high</dd>
          </div>
          <div>
            <dt className="text-ink-400">Model</dt>
            <dd className="mt-0.5 font-mono text-ink-800">rules-baseline-v1</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (id === "routing") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] text-ink-400">risk rules · server-side</span>
          <span className="rounded border border-mint/25 bg-mint/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[#0d7a5f]">
            Enforced
          </span>
        </div>
        <div className="mt-3 divide-y divide-border border-y border-border">
          {[
            ["Transfers above 50,000.00", "Review"],
            ["4th collection from a customer in 1 hour", "Review"],
            ["Payouts above 1,000,000.00", "Block"]
          ].map(([rule, action]) => (
            <div key={rule} className="flex items-center justify-between gap-3 py-2.5 text-[11.5px]">
              <span className="text-ink-500">{rule}</span>
              <StatusBadge
                status={action.toLowerCase()}
                label={action}
                tone={action === "Review" ? "warning" : action === "Block" ? "danger" : "success"}
              />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10.5px] leading-relaxed text-ink-400">
          Evaluated before the record is written. Review holds posting until a person decides.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <span className="font-mono text-[10.5px] text-ink-400">authenticated endpoints</span>
      <div className="mt-3 space-y-2">
        {[
          ["POST", "/v1/collections"],
          ["POST", "/v1/fraud/analyze"],
          ["GET", "/v1/webhook-deliveries"]
        ].map(([method, path]) => (
          <div
            key={path}
            className="flex items-center gap-2 rounded-md border border-border bg-paper px-2.5 py-2"
          >
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[9px] font-medium",
                method === "GET"
                  ? "bg-mint-soft text-[#0d7a5f]"
                  : "bg-primary-soft text-[#4436cf]"
              )}
            >
              {method}
            </span>
            <span className="truncate font-mono text-[11px] text-ink-700">{path}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[10.5px] text-ink-400">
        Idempotency-Key required on financial writes.
      </p>
    </div>
  );
}

export function PlatformRows() {
  const [openId, setOpenId] = useState<string | null>("ledger");

  return (
    <section id="platform" className="scroll-mt-24 border-t border-border bg-card">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 lg:py-24">
        <Reveal className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-display text-[38px] leading-[1.05] tracking-[-0.03em] text-ink-950 sm:text-[46px]">
              The platform
            </h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-[1.7] text-ink-500">
              The ledger is the foundation. Intelligence and developer surfaces read and write
              around the same record instead of creating parallel histories.
            </p>
          </div>
          <p className="max-w-[280px] text-[12px] leading-relaxed text-ink-400">
            Routing is a browser preview in this build. Everything else below is backed by the Go
            API in this repository.
          </p>
        </Reveal>

        <div className="mt-10 border-t border-border">
          {pillars.map((pillar) => {
            const open = openId === pillar.id;
            return (
              <div key={pillar.id} className="border-b border-border">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : pillar.id)}
                  aria-expanded={open}
                  aria-controls={`pillar-${pillar.id}`}
                  className="flex w-full items-center gap-5 py-6 text-left"
                >
                  <span className="flex-1">
                    <span className="flex flex-wrap items-center gap-2.5">
                      <span className="text-[20px] font-semibold tracking-[-0.02em] text-ink-950">
                        {pillar.title}
                      </span>
                      {pillar.badge && (
                        <span className="rounded border border-mint/25 bg-mint/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[#0d7a5f]">
                          {pillar.badge}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[13.5px] text-ink-500">
                      {pillar.summary}
                    </span>
                  </span>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-ink-500">
                    {open ? <Minus className="size-4" /> : <Plus className="size-4" />}
                  </span>
                </button>

                <div
                  id={`pillar-${pillar.id}`}
                  aria-hidden={!open}
                  className={cn(
                    "grid transition-all duration-300 ease-out",
                    open
                      ? "grid-rows-[1fr] pb-8 opacity-100"
                      : "grid-rows-[0fr] opacity-0"
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="grid gap-8 md:grid-cols-[1.1fr_0.9fr] md:gap-12">
                      <div>
                        <p className="text-[13.5px] leading-[1.75] text-ink-500">
                          {pillar.description}
                        </p>
                        <ul className="mt-5 space-y-2.5">
                          {pillar.bullets.map((bullet) => (
                            <li key={bullet} className="flex gap-2.5 text-[12.5px] text-ink-600">
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-mint" />
                              {bullet}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <PillarVisual id={pillar.id} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
