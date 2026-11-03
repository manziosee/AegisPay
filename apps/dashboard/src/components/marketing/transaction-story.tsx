"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { StatusBadge } from "@/components/data/status-badge";
import { Reveal } from "./reveal";
import { SAMPLE_EVENTS } from "@/lib/sample-data";
import { cn } from "@/lib/utils";

export function TransactionStory() {
  const [activeId, setActiveId] = useState(SAMPLE_EVENTS[0].id);
  const reduce = useReducedMotion();
  const active = SAMPLE_EVENTS.find((event) => event.id === activeId) ?? SAMPLE_EVENTS[0];

  return (
    <section id="transaction" className="scroll-mt-24 border-t border-border bg-paper">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 lg:py-24">
        <Reveal className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-end">
          <div>
            <h2 className="font-display text-[38px] leading-[1.05] tracking-[-0.03em] text-ink-950 sm:text-[46px]">
              One transaction, end to end.
            </h2>
            <p className="mt-4 max-w-[480px] text-[15px] leading-[1.7] text-ink-500">
              AegisPay keeps the operational record around a payment: who created it, what risk
              said, who approved it, how it posted, and whether a statement line matched.
            </p>
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-4 lg:items-end lg:border-t-0 lg:pt-0">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">
              Sample reference
            </span>
            <span className="font-mono text-[13px] text-ink-800">COL-2048 · RWF 4,200</span>
            <span className="text-[11.5px] text-ink-400">
              Events below follow the order the sandbox records them.
            </span>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:gap-10">
          <Reveal>
            <ol className="relative space-y-1 border-l border-border pl-0">
              {SAMPLE_EVENTS.map((event, index) => {
                const selected = event.id === activeId;
                return (
                  <li key={event.id} className="relative">
                    <span
                      className={cn(
                        "absolute -left-[4.5px] top-6 size-2 rounded-full border-2 border-paper",
                        selected ? "bg-mint" : "bg-ink-300"
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => setActiveId(event.id)}
                      aria-pressed={selected}
                      className={cn(
                        "w-full rounded-lg border px-4 py-3.5 text-left transition-colors",
                        selected
                          ? "border-border bg-card shadow-panel"
                          : "border-transparent hover:bg-white/60"
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2.5">
                          <span className="font-mono text-[10.5px] text-ink-400">
                            {event.timestamp}
                          </span>
                          <span
                            className={cn(
                              "text-[13.5px] font-medium",
                              selected ? "text-ink-950" : "text-ink-700"
                            )}
                          >
                            {event.label}
                          </span>
                        </span>
                        <StatusBadge status={event.state} label={event.state} />
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-3">
                        <span className="font-mono text-[10.5px] text-ink-400">
                          {event.source}
                        </span>
                        <span className="text-[10.5px] text-ink-300">
                          {index + 1} of {SAMPLE_EVENTS.length}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-panel">
              <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400">
                    Evidence
                  </p>
                  <h3 className="mt-1 text-[15px] font-semibold text-ink-950">{active.label}</h3>
                </div>
                <StatusBadge status={active.state} label={active.state} />
              </div>

              <motion.div
                key={active.id}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22 }}
                className="px-5 py-5"
              >
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                  {active.fields.map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-ink-400">{label}</dt>
                      <dd className="mt-1 break-words font-mono text-[12.5px] text-ink-800">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-5 border-t border-border pt-4 text-[13px] leading-relaxed text-ink-500">
                  {active.detail}
                </p>
              </motion.div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-paper-muted px-5 py-3">
                <span className="font-mono text-[10.5px] text-ink-400">{active.source}</span>
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">
                  Sample values
                  <ArrowUpRight className="size-3" />
                </span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
