import Link from "next/link";
import { BookOpenCheck, FileCheck2, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { SampleRecord } from "@/components/marketing/sample-record";
import { stockPhotos } from "@/lib/marketing";

const records = [
  { icon: ShieldCheck, text: "Risk score and review decision" },
  { icon: FileCheck2, text: "Approval count and reviewer decision" },
  { icon: BookOpenCheck, text: "Ledger posting and statement match" }
];

export function AuthShell({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-paper lg:grid-cols-[1.02fr_0.98fr]">
      <aside className="relative hidden overflow-hidden bg-night lg:block">
        <img
          src={stockPhotos.finance}
          alt="RDNE Stock project on Pexels — finance operator reviewing printed statements at a desk"
          className="absolute inset-0 size-full object-cover opacity-35"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-night/90 via-night/70 to-night" />
        <div className="pointer-events-none absolute inset-0 technical-grid opacity-50" />

        <div className="relative flex h-full flex-col p-10 xl:p-12">
          <Link href="/" aria-label="AegisPay home" className="w-fit">
            <Wordmark size="md" />
          </Link>

          <div className="mt-auto max-w-[500px] pb-8">
            <h1 className="font-display text-[46px] leading-[1.03] tracking-[-0.035em] text-on-night">
              The record behind the decision.
            </h1>
            <p className="mt-4 max-w-[430px] text-[14px] leading-[1.75] text-on-night-muted">
              Collections, risk assessments, approvals, ledger postings and statement matches stay
              together in one workspace.
            </p>
            <ul className="mt-6 space-y-2.5">
              {records.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-2.5 text-[12.5px] text-on-night/80">
                  <Icon className="size-4 text-mint" strokeWidth={1.8} />
                  {text}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-auto flex items-end justify-between gap-6">
            <SampleRecord compact className="w-[300px] border-white/10" />
            <span className="mb-1 inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted">
              <span className="size-1.5 rounded-full bg-mint" />
              Sandbox
            </span>
          </div>
        </div>
      </aside>

      <main className="flex min-h-screen flex-col px-5 py-8 sm:px-8 lg:py-10">
        <div className="flex items-center justify-between lg:justify-end">
          <Link href="/" className="lg:hidden" aria-label="AegisPay home">
            <Wordmark size="sm" tone="light" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-[12px] text-ink-500 transition-colors hover:text-ink-950"
          >
            ← Back to AegisPay
          </Link>
        </div>

        <div className="my-auto w-full max-w-[400px] self-center py-10">
          <h2 className="font-display text-[34px] leading-[1.08] tracking-[-0.03em] text-ink-950">
            {title}
          </h2>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-500">{description}</p>
          <div className="mt-7">{children}</div>
        </div>

        <p className="mx-auto mt-auto max-w-[400px] text-center text-[10.5px] leading-relaxed text-ink-400">
          AegisPay records and checks payments; your bank or provider moves the money.{" "}
          <Link href="/terms" className="underline">Terms</Link> ·{" "}
          <Link href="/privacy" className="underline">Privacy</Link>
        </p>
      </main>
    </div>
  );
}
