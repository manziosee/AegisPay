import { LegalLinks } from "@/components/legal/legal-page";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/logo";
import { Reveal } from "./reveal";

const boundaries = [
  {
    label: "Ledger",
    value: "Internal records only",
    detail: "Balances describe sandbox ledger activity, not bank-held funds."
  },
  {
    label: "Money movement",
    value: "No external execution",
    detail: "Requests and payout registers are workflow and evidence; your bank moves funds."
  },
  {
    label: "Providers",
    value: "None connected",
    detail: "No live payment provider, card data or settlement integration is configured."
  }
];

export function SandboxSection() {
  return (
    <section id="sandbox" className="scroll-mt-24 border-y border-border bg-paper-muted">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-16 sm:px-8 lg:py-20">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <Reveal>
            <div className="grid size-11 place-items-center rounded-xl border border-border bg-card text-ink-700">
              <ShieldCheck className="size-5" />
            </div>
            <h2 className="mt-5 font-display text-[34px] leading-[1.06] tracking-[-0.03em] text-ink-950 sm:text-[40px]">
              Sandbox boundaries
            </h2>
            <p className="mt-3 max-w-[400px] text-[14px] leading-[1.7] text-ink-500">
              AegisPay is a sandbox-first payment infrastructure project. These limits are part of
              the product, not fine print.
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <dl className="divide-y divide-border border-y border-border">
              {boundaries.map((item) => (
                <div key={item.label} className="grid gap-1 py-4 sm:grid-cols-[140px_1fr] sm:gap-6">
                  <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
                    {item.label}
                  </dt>
                  <dd>
                    <p className="text-[13.5px] font-medium text-ink-900">{item.value}</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                      {item.detail}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

export function CtaSection() {
  return (
    <section className="relative overflow-hidden bg-night">
      <div className="pointer-events-none absolute inset-0 technical-grid opacity-50" />
      <div className="pointer-events-none absolute left-1/2 top-0 size-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(19,181,140,0.14),transparent_68%)]" />
      <div className="relative mx-auto flex w-full max-w-[1000px] flex-col items-start gap-6 px-5 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:py-20">
        <div>
          <h2 className="font-display text-[34px] leading-[1.06] tracking-[-0.03em] text-on-night sm:text-[42px]">
            Start with a sandbox workspace.
          </h2>
          <p className="mt-3 max-w-[480px] text-[14px] leading-[1.7] text-on-night-muted">
            Register a business or personal workspace, then create a request, import a statement
            or evaluate a transaction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            asChild
            className="h-11 rounded-lg bg-primary px-5 text-[13.5px] font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Link href="/register">
              Create free account
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-11 rounded-lg border-white/15 bg-transparent px-5 text-[13.5px] text-on-night hover:bg-white/8 hover:text-on-night"
          >
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

const footerColumns = [
  {
    heading: "Platform",
    links: [
      { label: "Aegis Ledger", href: "/#platform" },
      { label: "Aegis Intelligence", href: "/#intelligence" },
      { label: "Reconciliation", href: "/#transaction" },
      { label: "Routing preview", href: "/#platform" }
    ]
  },
  {
    heading: "Developers",
    links: [
      { label: "API surface", href: "/#developers" },
      { label: "Webhook signatures", href: "/#developers" },
      { label: "Transaction timeline", href: "/#transaction" },
      { label: "OpenAPI contract", href: "https://github.com/manziosee/AegisPay/blob/main/docs/api/openapi.yaml" }
    ]
  },
  {
    heading: "Account",
    links: [
      { label: "Sign in", href: "/login" },
      { label: "Create free account", href: "/register" },
      { label: "Sandbox boundaries", href: "/#sandbox" },
      { label: "Repository", href: "https://github.com/manziosee/AegisPay" }
    ]
  }
];

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-night">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-12 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.3fr_2fr]">
          <div>
            <Wordmark size="md" />
            <p className="mt-4 max-w-[300px] text-[12.5px] leading-relaxed text-on-night-muted">
              Ledger, risk and approval records for business payment operations. Your bank moves the money; AegisPay keeps the proof.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {footerColumns.map((column) => (
              <div key={column.heading}>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted/60">
                  {column.heading}
                </p>
                <ul className="mt-3 space-y-2">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-[12.5px] text-on-night-muted transition-colors hover:text-on-night"
                        {...(link.href.startsWith("http")
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[11px] text-on-night-muted/60">
            © {new Date().getFullYear()} AegisPay
          </span>
          <LegalLinks className="text-[11px] text-on-night-muted/80" />
        </div>
      </div>
    </footer>
  );
}
