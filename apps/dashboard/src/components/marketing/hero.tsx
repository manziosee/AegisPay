"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, BadgeCheck, BookOpenCheck, Landmark, ShieldCheck, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SampleRecord } from "./sample-record";
import { stockPhotos } from "@/lib/marketing";

const capabilities = [
  { icon: BookOpenCheck, label: "Double-entry ledger" },
  { icon: BadgeCheck, label: "Separate-user approval" },
  { icon: Landmark, label: "Statement matching" },
  { icon: Webhook, label: "Signed webhooks" }
];

export function Hero() {
  const reduce = useReducedMotion();
  const rise = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] as const }
  });

  return (
    <section className="relative overflow-hidden bg-night pt-[72px] text-on-night">
      <div className="pointer-events-none absolute inset-0 technical-grid opacity-70" />
      <div className="pointer-events-none absolute -right-40 -top-40 size-[560px] rounded-full bg-[radial-gradient(circle,rgba(19,181,140,0.16),transparent_66%)]" />
      <div className="pointer-events-none absolute -left-52 top-1/3 size-[520px] rounded-full bg-[radial-gradient(circle,rgba(90,75,255,0.14),transparent_68%)]" />

      <div className="relative mx-auto w-full max-w-[1320px] px-5 pb-16 pt-12 sm:px-8 sm:pt-16 lg:pb-20 lg:pt-20">
        <div className="grid items-center gap-12 lg:grid-cols-[1.04fr_0.96fr] lg:gap-16">
          <div className="max-w-[640px]">
            <motion.h1
              {...rise(0.05)}
              className="font-display text-[44px] leading-[1.03] tracking-[-0.035em] sm:text-[56px] lg:text-[64px]"
            >
              The ledger, risk and{" "}
              <em className="italic text-mint">approval trail</em> for every payment.
            </motion.h1>
            <motion.p
              {...rise(0.14)}
              className="mt-6 max-w-[520px] text-[15px] leading-[1.75] text-on-night-muted"
            >
              Run collections, transfers, approvals, reconciliation and risk review on one
              double-entry ledger. Every decision keeps its evidence.
            </motion.p>

            <motion.div {...rise(0.22)} className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                asChild
                className="h-11 rounded-lg bg-primary px-5 text-[13.5px] font-semibold text-primary-foreground shadow-[0_10px_30px_rgba(90,75,255,0.28)] hover:bg-primary/90"
              >
                <Link href="/register">
                  Create sandbox account
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-11 rounded-lg border-white/15 bg-transparent px-5 text-[13.5px] text-on-night hover:bg-white/8 hover:text-on-night"
              >
                <Link href="/#transaction">Inspect a sample transaction</Link>
              </Button>
            </motion.div>

            <motion.p
              {...rise(0.3)}
              className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-on-night-muted"
            >
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-mint" />
              Sandbox only. Simulated ledger activity, no live payment provider and no card data.
            </motion.p>
          </div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto w-full max-w-[560px] pb-10 lg:pb-0"
          >
            <div className="relative h-[430px] overflow-hidden rounded-2xl border border-white/12 sm:h-[500px] lg:h-[560px]">
              <img
                src={stockPhotos.operator}
                alt="Mikhail Nilov on Pexels — business operator reviewing documents beside a laptop"
                className="absolute inset-0 size-full object-cover"
                loading="eager"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-night via-night/25 to-transparent" />
              <div className="absolute left-5 top-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-night/55 px-3 py-1.5 backdrop-blur-sm">
                <span className="size-1.5 rounded-full bg-mint" />
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-night/80">
                  Operations record
                </span>
              </div>
              <div className="absolute bottom-6 left-6 right-6">
                <p className="max-w-[330px] text-[13px] leading-relaxed text-on-night/80">
                  Collections are written first, then scored, approved and posted. A statement
                  line confirms the match later.
                </p>
              </div>
            </div>

            <div className="absolute -bottom-1 left-4 w-[300px] sm:left-6 sm:w-[330px] lg:-bottom-8 lg:-left-8">
              <SampleRecord />
            </div>
          </motion.div>
        </div>

        <div className="mt-14 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/10 pt-6 sm:grid-cols-4 lg:mt-16">
          {capabilities.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-2.5">
              <Icon className="size-4 text-mint" strokeWidth={1.8} />
              <span className="text-[12px] text-on-night-muted">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
