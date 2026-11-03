import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { NetworkLegend, RiskNetwork } from "@/components/brand/risk-network";
import { Reveal } from "./reveal";
import { signalExamples } from "@/lib/marketing";
import { cn } from "@/lib/utils";

const toneClass = {
  warning: "border-amber/25 bg-amber-soft text-[#8a5a12]",
  critical: "border-coral/25 bg-coral-soft text-[#a83422]",
  info: "border-primary/20 bg-primary-soft text-[#4436cf]"
} as const;

export function IntelligenceSection() {
  return (
    <section id="intelligence" className="scroll-mt-24 overflow-hidden bg-night">
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-40" />
      <div className="relative mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-8 lg:py-24">
        <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <Reveal>
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted/70">
                Sample relationship view
              </span>
              <NetworkLegend />
            </div>
            <RiskNetwork className="mt-4" showControls />
          </Reveal>

          <Reveal delay={0.08}>
            <h2 className="font-display text-[38px] leading-[1.05] tracking-[-0.03em] text-on-night sm:text-[44px]">
              Know the risk before you approve.
            </h2>
            <p className="mt-4 text-[14.5px] leading-[1.7] text-on-night-muted">
              Every transaction reference can be scored before review or finalization. The
              assessment stores a score, level, decision and model version, and opens a review case
              only when a person needs to act.
            </p>

            <div className="mt-7 divide-y divide-white/10 border-y border-white/10">
              {signalExamples.map((signal) => (
                <div key={signal.code} className="py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[10.5px] text-mint">{signal.code}</span>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                        toneClass[signal.tone]
                      )}
                    >
                      {signal.observed}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-on-night/80">
                    {signal.description}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-on-night-muted/60">
                    {signal.basis}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[11.5px] leading-relaxed text-on-night-muted/70">
              Values above are a sample. Inside the workspace, every derived signal states the
              records it was computed from.
            </p>

            <Link
              href="/register"
              className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-mint hover:text-mint/80"
            >
              Evaluate a transaction in the sandbox
              <ArrowUpRight className="size-4" />
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
