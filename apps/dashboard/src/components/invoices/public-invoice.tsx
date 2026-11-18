"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Printer } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { formatDate, formatMinor } from "@/lib/format";
import type { PublicInvoice } from "@/lib/types";
import { cn } from "@/lib/utils";

const stateText: Record<PublicInvoice["state"], { label: string; className: string }> = {
  open: { label: "Awaiting payment", className: "bg-primary-soft text-ink-900" },
  overdue: { label: "Overdue", className: "bg-amber-soft text-[#7a5210]" },
  paid: { label: "Paid", className: "bg-mint-soft text-[#0b6b52]" },
  cancelled: { label: "Cancelled", className: "bg-paper-muted text-ink-500" }
};

/** What a customer sees when they open an invoice link. No sign-in. */
export function PublicInvoiceView({ token }: { token: string }) {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/proxy/v1/public/invoices/${encodeURIComponent(token)}`, { cache: "no-store", credentials: "omit" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok) setError(body.error ?? "This invoice could not be loaded.");
        else setInvoice(body as PublicInvoice);
      })
      .catch(() => active && setError("This invoice could not be loaded. Check your connection and try again."));
    return () => {
      active = false;
    };
  }, [token]);

  const copyReference = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.reference);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the reference stays visible to copy by hand.
    }
  };

  if (error) {
    return (
      <main className="mx-auto max-w-[640px] px-4 py-16 text-center">
        <h1 className="text-[20px] font-semibold text-ink-950">Invoice unavailable</h1>
        <p className="mt-2 text-[13px] text-ink-500">{error}</p>
        <p className="mt-1 text-[12px] text-ink-400">Ask the business that sent it for a new link.</p>
      </main>
    );
  }
  if (!invoice) {
    return <main className="mx-auto max-w-[760px] px-4 py-16 text-center text-[13px] text-ink-400">Loading invoice…</main>;
  }
  const state = stateText[invoice.state];
  const cur = invoice.currency;
  return (
    <main className="min-h-screen bg-paper px-4 py-8 print:bg-white print:p-0">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
          <span className="text-[11px] text-ink-400">Shared with you by {invoice.business.name}</span>
          <Button variant="outline" size="sm" className="h-8 text-[11.5px]" onClick={() => window.print()}>
            <Printer className="size-3.5" />
            Print or save as PDF
          </Button>
        </div>

        {invoice.business.practice && (
          <p className="mb-4 rounded-lg border border-amber/30 bg-amber-soft px-4 py-2.5 text-[12px] text-[#7a5210]">
            This invoice comes from a practice workspace. No real payment is being requested.
          </p>
        )}

        <article className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-10 print:border-0 print:shadow-none">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
            <div>
              <p className="text-[20px] font-semibold text-ink-950">{invoice.business.name}</p>
              {invoice.business.country_code && <p className="mt-0.5 text-[12px] text-ink-400">{invoice.business.country_code}</p>}
            </div>
            <div className="text-right">
              <p className="text-[12px] uppercase tracking-[0.08em] text-ink-400">Invoice</p>
              <p className="font-mono text-[18px] font-semibold text-ink-950">{invoice.invoice_number ?? invoice.reference}</p>
              <span className={cn("mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-medium", state.className)}>{state.label}</span>
            </div>
          </header>

          <dl className="grid gap-4 border-b border-border py-6 text-[12.5px] sm:grid-cols-3">
            <div>
              <dt className="text-ink-400">Billed to</dt>
              <dd className="mt-0.5 font-medium text-ink-900">{invoice.customer_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-400">Issued</dt>
              <dd className="mt-0.5 text-ink-900">{formatDate(invoice.issued_at)}</dd>
            </div>
            <div>
              <dt className="text-ink-400">{invoice.state === "paid" ? "Paid" : "Due"}</dt>
              <dd className="mt-0.5 text-ink-900">
                {invoice.state === "paid" ? formatDate(invoice.paid_at) : invoice.due_date ? formatDate(`${invoice.due_date}T12:00:00Z`) : "On receipt"}
              </dd>
            </div>
          </dl>

          <table className="mt-6 w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-ink-400">
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 text-right font-medium">Qty</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">Unit price</th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.line_items.map((line, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td className="py-2.5 pr-3 text-ink-800">{line.description}</td>
                  <td className="py-2.5 text-right font-mono text-ink-600">{line.quantity}</td>
                  <td className="hidden py-2.5 text-right font-mono text-ink-600 sm:table-cell">{formatMinor(line.unit_amount, cur)}</td>
                  <td className="whitespace-nowrap py-2.5 text-right font-mono text-ink-900">{formatMinor(line.amount ?? 0, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto mt-4 grid max-w-[280px] grid-cols-[1fr_auto] gap-y-1 text-[12.5px]">
            <dt className="text-ink-500">Subtotal</dt>
            <dd className="text-right font-mono text-ink-800">{formatMinor(invoice.subtotal, cur)}</dd>
            <dt className="text-ink-500">Tax{invoice.tax_rate_bps ? ` (${invoice.tax_rate_bps / 100}%)` : ""}</dt>
            <dd className="text-right font-mono text-ink-800">{formatMinor(invoice.tax, cur)}</dd>
            <dt className="border-t border-border pt-2 text-[14px] font-semibold text-ink-950">Total</dt>
            <dd className="border-t border-border pt-2 text-right font-mono text-[14px] font-semibold text-ink-950">{formatMinor(invoice.amount, cur)}</dd>
          </dl>

          {invoice.notes && <p className="mt-6 whitespace-pre-line text-[12.5px] text-ink-700">{invoice.notes}</p>}

          {invoice.state !== "paid" && invoice.state !== "cancelled" && (
            <section className="mt-8 rounded-lg border border-border bg-paper p-5" aria-label="How to pay">
              <h2 className="text-[14px] font-semibold text-ink-950">How to pay</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-ink-600">Use this reference with your payment:</span>
                <code className="rounded-md border border-border bg-card px-2 py-1 font-mono text-[14px] font-semibold text-ink-950">{invoice.reference}</code>
                <Button variant="ghost" size="sm" className="h-7 text-[11px] print:hidden" onClick={() => void copyReference()}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {invoice.payment_instructions ? (
                <pre className="mt-4 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-ink-800">{invoice.payment_instructions}</pre>
              ) : (
                <p className="mt-3 text-[12.5px] text-ink-500">Contact {invoice.business.name} for their payment details.</p>
              )}
              <p className="mt-3 text-[11px] text-ink-400">Payment goes directly to {invoice.business.name}. AegisPay does not handle or hold the money.</p>
            </section>
          )}

          {invoice.footer && <p className="mt-8 border-t border-border pt-4 text-[11px] text-ink-400">{invoice.footer}</p>}
        </article>

        <footer className="mt-6 flex items-center justify-center gap-2 text-[11px] text-ink-400 print:hidden">
          Invoice by <Wordmark size="sm" markSize={16} tone="light" className="text-[12px]" />
        </footer>
      </div>
    </main>
  );
}
