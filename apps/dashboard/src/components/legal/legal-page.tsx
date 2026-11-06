import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";
import { LEGAL_LAST_UPDATED, SUPPORT_EMAIL } from "@/lib/site";

export type LegalSection = { heading: string; paragraphs?: string[]; items?: string[] };

export function LegalPage({ title, intro, sections }: { title: string; intro: string; sections: LegalSection[] }) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-border bg-night px-5 py-4 sm:px-8">
        <Link href="/" aria-label="AegisPay home">
          <Wordmark size="sm" />
        </Link>
      </header>
      <main className="mx-auto w-full max-w-[760px] px-5 py-10 sm:px-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-ink-950">{title}</h1>
        <p className="mt-1 text-[12px] text-ink-400">Last updated {LEGAL_LAST_UPDATED}</p>
        <p className="mt-5 text-[14px] leading-relaxed text-ink-700">{intro}</p>
        {sections.map((section) => (
          <section key={section.heading} className="mt-8">
            <h2 className="text-[16px] font-semibold text-ink-900">{section.heading}</h2>
            {section.paragraphs?.map((text) => (
              <p key={text} className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
                {text}
              </p>
            ))}
            {section.items && (
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-700">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <p className="mt-10 border-t border-border pt-5 text-[13px] text-ink-600">
          Questions? Write to{" "}
          <a className="font-medium text-primary hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <LegalLinks className="mt-3 text-[12px] text-ink-500" />
      </main>
    </div>
  );
}

/** Links to the legal pages, used in every footer. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <span className={`inline-flex flex-wrap gap-x-3 gap-y-1 ${className ?? ""}`}>
      <Link href="/terms" className="hover:underline">Terms</Link>
      <Link href="/privacy" className="hover:underline">Privacy</Link>
      <Link href="/cookies" className="hover:underline">Cookies</Link>
      <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:underline">Support</a>
    </span>
  );
}
