"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Link2Off,
  Mail,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Settings2,
  Square
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  InvoiceFields,
  draftFromLines,
  emptyLine,
  priceDraft,
  type InvoiceDraft
} from "@/components/invoices/invoice-form";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMinor } from "@/lib/format";
import { canFinance } from "@/lib/roles";
import type { Customer, Invoice, InvoiceSettings, InvoiceState, InvoiceSummary, Page, RecurringInvoice } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = InvoiceState | "all";
const FILTERS: Filter[] = ["all", "open", "overdue", "paid", "cancelled"];
const stateTone: Record<InvoiceState, "success" | "warning" | "danger" | "neutral" | "info"> = {
  open: "info",
  overdue: "warning",
  paid: "success",
  cancelled: "neutral"
};
const frequencyLabel = { weekly: "Every week", monthly: "Every month", quarterly: "Every 3 months", yearly: "Every year" };

function defaultDue(days = 14) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function InvoicesPage() {
  const { session, role } = useSession();
  const { data: workspace } = useWorkspaceData();
  const organization = workspace.organization;
  const canManage = canFinance(role ?? undefined);
  const [tab, setTab] = useState<"invoices" | "recurring">("invoices");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<InvoiceSummary[]>([]);
  const [schedules, setSchedules] = useState<RecurringInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const [editor, setEditor] = useState<{ mode: "create" | "edit" | "duplicate" | "recurring"; invoice?: Invoice } | null>(null);
  const [closing, setClosing] = useState<{ invoice: Invoice; action: "cancel" | "mark-paid" } | null>(null);
  const [sending, setSending] = useState<Invoice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError("");
    try {
      const [list, recurring, people] = await Promise.all([
        api<{ data: Invoice[]; summary: InvoiceSummary[] }>("/invoices"),
        api<{ data: RecurringInvoice[] }>("/recurring-invoices"),
        api<Page<Customer>>("/customers?limit=100")
      ]);
      setInvoices(list.data);
      setSummary(list.summary);
      setSchedules(recurring.data);
      setCustomers(people.data.filter((c) => c.status !== "archived"));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (invoice: Invoice) => {
    setInvoices((current) => current.map((item) => (item.id === invoice.id ? invoice : item)));
    setViewing((current) => (current?.id === invoice.id ? invoice : current));
  };

  const refreshOne = async (id: string) => {
    const fresh = await api<Invoice>(`/invoices/${encodeURIComponent(id)}`);
    replace(fresh);
    return fresh;
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (filter !== "all" && inv.state !== filter) return false;
      if (!needle) return true;
      return [inv.invoice_number ?? "", inv.reference, inv.customer_name ?? "", inv.description].some((v) => v.toLowerCase().includes(needle));
    });
  }, [invoices, filter, query]);

  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: invoices.length, open: 0, overdue: 0, paid: 0, cancelled: 0 };
    invoices.forEach((inv) => (out[inv.state] += 1));
    return out;
  }, [invoices]);

  const copyLink = async (invoice: Invoice) => {
    try {
      const url = invoice.share_url ?? (await api<{ share_url: string }>(`/invoices/${encodeURIComponent(invoice.id)}/share`, { method: "POST" })).share_url;
      await navigator.clipboard.writeText(url);
      toast.success("Customer link copied. Anyone with it can view this invoice.");
      await refreshOne(invoice.id);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const disableLink = async (invoice: Invoice) => {
    try {
      await api(`/invoices/${encodeURIComponent(invoice.id)}/share`, { method: "DELETE" });
      await refreshOne(invoice.id);
      toast.success("The old link no longer works. Copy the link again to make a new one.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const changeSchedule = async (schedule: RecurringInvoice, patch: { status?: string; auto_send?: boolean }) => {
    try {
      const updated = await api<RecurringInvoice>(`/recurring-invoices/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setSchedules((current) => current.map((s) => (s.id === updated.id ? updated : s)));
      toast.success(
        patch.status === "paused" ? "Schedule paused." : patch.status === "ended" ? "Schedule ended." : patch.status === "active" ? "Schedule resumed." : "Schedule updated."
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const actions = (invoice: Invoice) => (
    <>
      {invoice.share_url && (
        <DropdownMenuItem asChild>
          <a href={invoice.share_url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" />
            Open customer view
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => void copyLink(invoice)}>
        <Copy className="size-3.5" />
        Copy customer link
      </DropdownMenuItem>
      {canManage && invoice.status === "open" && (
        <>
          <DropdownMenuItem onSelect={() => setSending(invoice)}>
            <Mail className="size-3.5" />
            Email to customer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditor({ mode: "edit", invoice })}>
            <Pencil className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setClosing({ invoice, action: "mark-paid" })}>
            <CheckCircle2 className="size-3.5" />
            Mark as paid
          </DropdownMenuItem>
        </>
      )}
      {canManage && (
        <DropdownMenuItem onSelect={() => setEditor({ mode: "duplicate", invoice })}>
          <Copy className="size-3.5" />
          Duplicate
        </DropdownMenuItem>
      )}
      {canManage && invoice.share_url && (
        <DropdownMenuItem onSelect={() => void disableLink(invoice)}>
          <Link2Off className="size-3.5" />
          Switch off link
        </DropdownMenuItem>
      )}
      {canManage && invoice.status === "open" && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-coral focus:text-coral" onSelect={() => setClosing({ invoice, action: "cancel" })}>
            <Ban className="size-3.5" />
            Cancel invoice
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  const primary = summary.slice().sort((a, b) => b.outstanding - a.outstanding)[0];

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Bill customers, share a link they can pay from, and see what is still owed. An invoice is marked paid when its reference appears on a bank or provider statement."
        actions={
          canManage ? (
            <>
              <Button variant="outline" className="h-9 border-border bg-card text-[12.5px]" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="size-3.5" />
                Payment details
              </Button>
              <Button
                className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
                onClick={() => setEditor({ mode: tab === "recurring" ? "recurring" : "create" })}
              >
                <Plus className="size-3.5" />
                {tab === "recurring" ? "New schedule" : "New invoice"}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {[
          ["Still owed", primary?.outstanding],
          ["Overdue", primary?.overdue],
          ["Paid in the last 30 days", primary?.paid_last_30_days]
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-[11px] text-ink-400">{label as string}</p>
            <p className="mt-1 truncate text-[19px] font-semibold text-ink-950">
              {primary ? formatMinor((value as number) ?? 0, primary.currency) : loading ? "…" : "—"}
            </p>
            {summary.length > 1 && <p className="mt-0.5 text-[10.5px] text-ink-400">In {primary?.currency}; other currencies are listed below.</p>}
          </div>
        ))}
      </div>

      <div role="tablist" aria-label="Invoices" className="mb-3 flex gap-1 border-b border-border">
        {(
          [
            ["invoices", "Invoices", FileText],
            ["recurring", "Recurring", Repeat]
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px]",
              tab === value ? "border-primary font-medium text-ink-950" : "border-transparent text-ink-500 hover:text-ink-800"
            )}
          >
            <Icon className="size-3.5" />
            {label}
            <span className="font-mono text-[10.5px] text-ink-400">{value === "invoices" ? invoices.length : schedules.filter((s) => s.status !== "ended").length}</span>
          </button>
        ))}
      </div>

      {loadError ? (
        <Panel>
          <EmptyState
            icon={FileText}
            title="Invoices could not be loaded"
            text={loadError}
            action={
              <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        </Panel>
      ) : tab === "invoices" ? (
        <Panel>
          <PanelHeader
            title="All invoices"
            description={summary.length > 1 ? summary.map((s) => `${s.currency} ${formatMinor(s.outstanding, s.currency)} owed`).join(" · ") : undefined}
            action={
              <Input
                aria-label="Search invoices"
                placeholder="Search number, customer or reference"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-[220px] bg-card text-[11.5px]"
              />
            }
          />
          <div role="group" aria-label="Filter invoices" className="flex flex-wrap gap-1.5 border-b border-border px-5 py-2.5">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] capitalize",
                  filter === value ? "border-primary/30 bg-primary-soft font-medium text-ink-950" : "border-border text-ink-500 hover:text-ink-800"
                )}
              >
                {value} <span className="font-mono text-[10px] text-ink-400">{counts[value]}</span>
              </button>
            ))}
          </div>
          {!loading && shown.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={invoices.length === 0 ? "No invoices yet" : "No invoices match"}
              text={
                invoices.length === 0
                  ? "Create an invoice, then copy its link or email it. Add your bank or mobile-money details under Payment details so customers know how to pay."
                  : "Change the filter or the search."
              }
              action={
                invoices.length === 0 && canManage ? (
                  <Button className="h-8 bg-primary text-[11.5px] text-primary-foreground" onClick={() => setEditor({ mode: "create" })}>
                    <Plus className="size-3.5" />
                    New invoice
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-border bg-paper-muted/60">
                    {["Invoice", "Customer", "Issued", "Due", "Amount", "Status", ""].map((h, i) => (
                      <th key={h || i} className={cn("px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5", h === "Amount" && "text-right")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((inv) => (
                    <tr key={inv.id} className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-paper-muted/40" onClick={() => setViewing(inv)}>
                      <td className="px-5 py-3">
                        <p className="font-mono text-[11.5px] text-ink-900">{inv.invoice_number ?? inv.reference}</p>
                        <p className="max-w-[220px] truncate text-[10.5px] text-ink-400">{inv.description}</p>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{inv.customer_name ?? "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[11px] text-ink-500">{formatDate(inv.created_at)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[11px] text-ink-500">{inv.due_date ? formatDate(`${inv.due_date}T12:00:00Z`) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ink-950">{formatMinor(inv.amount, inv.currency)}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={inv.state} tone={stateTone[inv.state]} />
                      </td>
                      <td className="px-5 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${inv.invoice_number ?? inv.reference}`}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {actions(inv)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="Recurring invoices" description="Issued automatically on their date. Rent, membership dues, retainers, school fees." />
          {schedules.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="No schedules yet"
              text="Set up an invoice that is issued every week, month, quarter or year, and emailed to the customer if you like."
              action={
                canManage ? (
                  <Button className="h-8 bg-primary text-[11.5px] text-primary-foreground" onClick={() => setEditor({ mode: "recurring" })}>
                    <Plus className="size-3.5" />
                    New schedule
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {schedules.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium text-ink-900">
                      {s.customer_name} · {formatMinor(s.amount, s.currency)}
                    </p>
                    <p className="text-[11px] text-ink-500">
                      {frequencyLabel[s.frequency]} · {s.status === "ended" ? "ended" : `next on ${formatDate(`${s.next_run_on}T12:00:00Z`)}`} · due {s.due_days} days later
                      {s.end_on ? ` · until ${formatDate(`${s.end_on}T12:00:00Z`)}` : ""} · {s.issued_count} issued
                      {s.auto_send ? (s.customer_email ? " · emailed automatically" : " · will email once the customer has an address") : ""}
                    </p>
                  </div>
                  <StatusBadge status={s.status} tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "neutral"} />
                  {canManage && s.status !== "ended" && (
                    <span className="inline-flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void changeSchedule(s, { status: s.status === "active" ? "paused" : "active" })}>
                        {s.status === "active" ? <Pause className="size-3" /> : <Play className="size-3" />}
                        {s.status === "active" ? "Pause" : "Resume"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void changeSchedule(s, { auto_send: !s.auto_send })}>
                        <Mail className="size-3" />
                        {s.auto_send ? "Stop emailing" : "Email automatically"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 border-coral/30 text-[11px] text-coral" onClick={() => void changeSchedule(s, { status: "ended" })}>
                        <Square className="size-3" />
                        End
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Sheet open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[540px]">
          {viewing && (
            <>
              <SheetHeader className="border-b border-border bg-card px-5 py-4">
                <div className="flex items-center gap-2">
                  <StatusBadge status={viewing.state} tone={stateTone[viewing.state]} />
                  {viewing.recurring_id && <span className="text-[10.5px] text-ink-400">from a recurring schedule</span>}
                </div>
                <SheetTitle className="mt-2 font-mono text-[16px] text-ink-950">{viewing.invoice_number ?? viewing.reference}</SheetTitle>
                <SheetDescription className="text-[11.5px] text-ink-500">
                  {viewing.customer_name ?? "No customer"} · {formatMinor(viewing.amount, viewing.currency)}
                </SheetDescription>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="h-8 text-[11.5px]" onClick={() => void copyLink(viewing)}>
                    <Link2 className="size-3.5" />
                    Copy customer link
                  </Button>
                  {canManage && viewing.status === "open" && (
                    <Button size="sm" className="h-8 bg-primary text-[11.5px] text-primary-foreground" onClick={() => setSending(viewing)}>
                      <Mail className="size-3.5" />
                      Email to customer
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 text-[11.5px]">
                        More
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {actions(viewing)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </SheetHeader>
              <div className="space-y-4 p-5 text-[12px]">
                <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 rounded-lg border border-border bg-card p-4">
                  <dt className="text-ink-400">Payment reference</dt>
                  <dd className="font-mono text-ink-900">{viewing.reference}</dd>
                  <dt className="text-ink-400">Issued</dt>
                  <dd className="text-ink-800">{formatDate(viewing.created_at)}</dd>
                  <dt className="text-ink-400">Due</dt>
                  <dd className="text-ink-800">{viewing.due_date ? formatDate(`${viewing.due_date}T12:00:00Z`) : "—"}</dd>
                  <dt className="text-ink-400">Emailed</dt>
                  <dd className="text-ink-800">
                    {viewing.sent_at ? formatDate(viewing.sent_at) : "Not yet"}
                    {viewing.reminder_count > 0 ? ` · ${viewing.reminder_count} reminder${viewing.reminder_count > 1 ? "s" : ""}` : ""}
                  </dd>
                  {viewing.paid_at && (
                    <>
                      <dt className="text-ink-400">Paid</dt>
                      <dd className="text-ink-800">
                        {formatDate(viewing.paid_at)} · {viewing.status === "marked_paid" ? "marked by hand" : "confirmed by a statement"}
                      </dd>
                    </>
                  )}
                  {viewing.paid_note && (
                    <>
                      <dt className="text-ink-400">Note</dt>
                      <dd className="text-ink-800">{viewing.paid_note}</dd>
                    </>
                  )}
                </dl>
                <table className="w-full rounded-lg border border-border bg-card text-[11.5px]">
                  <thead>
                    <tr className="border-b border-border text-[10.5px] text-ink-400">
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewing.line_items.map((line, i) => (
                      <tr key={i} className="border-b border-border/70">
                        <td className="px-3 py-2 text-ink-800">{line.description}</td>
                        <td className="px-3 py-2 text-right font-mono text-ink-600">{line.quantity}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-ink-900">{formatMinor(line.amount ?? 0, viewing.currency)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={2} className="px-3 py-1.5 text-right text-ink-500">
                        Tax {viewing.tax_rate_bps ? `(${viewing.tax_rate_bps / 100}%)` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-ink-800">{formatMinor(viewing.tax, viewing.currency)}</td>
                    </tr>
                    <tr>
                      <td colSpan={2} className="px-3 py-2 text-right font-semibold text-ink-950">
                        Total
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold text-ink-950">{formatMinor(viewing.amount, viewing.currency)}</td>
                    </tr>
                  </tbody>
                </table>
                {viewing.notes && <p className="whitespace-pre-line rounded-lg border border-border bg-card p-3 text-ink-700">{viewing.notes}</p>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {editor && (
        <InvoiceEditor
          mode={editor.mode}
          invoice={editor.invoice}
          customers={customers}
          defaultCurrency={summary[0]?.currency ?? invoices[0]?.currency ?? ""}
          onClose={() => setEditor(null)}
          onSaved={async (message) => {
            toast.success(message);
            await load();
          }}
        />
      )}

      <FormDialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title={closing?.action === "cancel" ? `Cancel ${closing.invoice.invoice_number ?? "invoice"}?` : `Mark ${closing?.invoice.invoice_number ?? "invoice"} as paid`}
        description={
          closing?.action === "cancel"
            ? "The customer link will show the invoice as cancelled. This cannot be undone; create a new invoice if needed."
            : "Use this for cash, cheques or payments that will never appear on an imported statement. The note is kept in the audit trail."
        }
        submitLabel={closing?.action === "cancel" ? "Cancel invoice" : "Mark as paid"}
        destructive={closing?.action === "cancel"}
        onSubmit={async () => {
          if (!closing) return;
          const form = document.getElementById("close-invoice-note") as HTMLTextAreaElement | null;
          const paidOn = document.getElementById("close-invoice-date") as HTMLInputElement | null;
          await api(`/invoices/${encodeURIComponent(closing.invoice.id)}/${closing.action}`, {
            method: "POST",
            body: JSON.stringify({ note: form?.value ?? "", paid_on: paidOn?.value ?? "" })
          });
          await refreshOne(closing.invoice.id);
          setSummary((await api<{ summary: InvoiceSummary[] }>("/invoices")).summary);
          toast.success(closing.action === "cancel" ? "Invoice cancelled." : "Invoice marked as paid.");
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="close-invoice-note">{closing?.action === "cancel" ? "Reason" : "How it was paid"}</Label>
          <Textarea id="close-invoice-note" required maxLength={500} rows={2} className="text-[12px]" placeholder={closing?.action === "cancel" ? "Raised by mistake" : "Cash at the shop, receipt 0412"} />
        </div>
        {closing?.action === "mark-paid" && <Field id="close-invoice-date" label="Paid on" type="date" max={today()} defaultValue={today()} />}
      </FormDialog>

      <FormDialog
        open={sending !== null}
        onOpenChange={(open) => !open && setSending(null)}
        title={`Email ${sending?.invoice_number ?? "invoice"}`}
        description={
          sending?.customer_email
            ? `To ${sending.customer_email}. The email has a link to the invoice and your payment details; replies come to you.`
            : "This invoice's customer has no email address. Add one on the Customers page first."
        }
        submitLabel="Send email"
        onSubmit={async () => {
          if (!sending) return;
          const message = (document.getElementById("send-invoice-message") as HTMLTextAreaElement | null)?.value ?? "";
          const result = await api<{ to: string }>(`/invoices/${encodeURIComponent(sending.id)}/send`, { method: "POST", body: JSON.stringify({ message }) });
          await refreshOne(sending.id);
          toast.success(`Invoice emailed to ${result.to}.`);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="send-invoice-message">Message (optional)</Label>
          <Textarea id="send-invoice-message" maxLength={1000} rows={3} className="text-[12px]" placeholder="Thank you for your business." />
        </div>
      </FormDialog>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} country={organization?.country_code ?? undefined} />}
    </div>
  );
}

function InvoiceEditor({
  mode,
  invoice,
  customers,
  defaultCurrency,
  onClose,
  onSaved
}: {
  mode: "create" | "edit" | "duplicate" | "recurring";
  invoice?: Invoice;
  customers: Customer[];
  defaultCurrency: string;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InvoiceDraft>(() =>
    invoice
      ? {
          customerId: invoice.customer_id ?? "",
          currency: invoice.currency,
          lines: draftFromLines(invoice.line_items, invoice.currency),
          taxPercent: invoice.tax_rate_bps ? String(invoice.tax_rate_bps / 100) : "",
          dueDate: mode === "edit" ? invoice.due_date ?? "" : defaultDue(),
          notes: invoice.notes
        }
      : { customerId: "", currency: defaultCurrency || "USD", lines: [{ ...emptyLine }], taxPercent: "", dueDate: defaultDue(), notes: "" }
  );
  const [schedule, setSchedule] = useState({ frequency: "monthly", startOn: today(), endOn: "", dueDays: "14", autoSend: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recurring = mode === "recurring";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const priced = priceDraft(draft);
    if (priced.errors.length) {
      setError(priced.errors[0]);
      return;
    }
    if (recurring && !draft.customerId) {
      setError("A recurring invoice needs a customer.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = { customer_id: draft.customerId, currency: priced.currency, line_items: priced.lines, tax_rate_bps: priced.taxBps, notes: draft.notes };
      if (recurring) {
        await api("/recurring-invoices", {
          method: "POST",
          body: JSON.stringify({ ...body, frequency: schedule.frequency, start_on: schedule.startOn, end_on: schedule.endOn, due_days: Number(schedule.dueDays) || 0, auto_send: schedule.autoSend })
        });
        await onSaved("Schedule saved. The first invoice is issued on its start date.");
      } else if (mode === "edit" && invoice) {
        await api(`/invoices/${encodeURIComponent(invoice.id)}`, { method: "PATCH", body: JSON.stringify({ ...body, due_date: draft.dueDate }) });
        await onSaved("Invoice updated. Its payment reference is unchanged.");
      } else {
        const created = await api<Invoice>("/invoices", { method: "POST", body: JSON.stringify({ ...body, due_date: draft.dueDate }) });
        await onSaved(`${created.invoice_number} created. Copy its link or email it to the customer.`);
      }
      onClose();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">
            {recurring ? "New recurring invoice" : mode === "edit" ? `Edit ${invoice?.invoice_number ?? "invoice"}` : mode === "duplicate" ? "Duplicate invoice" : "New invoice"}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {recurring
              ? "An invoice is issued on each date with these lines. Customers pay using the reference on each invoice."
              : "The invoice gets the next number and its own payment reference."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <InvoiceFields draft={draft} onChange={setDraft} customers={customers} requireCustomer={recurring} showDueDate={!recurring} />
          {recurring && (
            <div className="grid gap-3 rounded-lg border border-border bg-paper p-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="schedule-frequency">How often</Label>
                <select
                  id="schedule-frequency"
                  value={schedule.frequency}
                  onChange={(event) => setSchedule({ ...schedule, frequency: event.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12px]"
                >
                  {Object.entries(frequencyLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <Field id="schedule-start" label="First invoice on" type="date" min={today()} required value={schedule.startOn} onChange={(e) => setSchedule({ ...schedule, startOn: e.target.value })} />
              <Field id="schedule-due" label="Due after (days)" type="number" min={0} max={365} value={schedule.dueDays} onChange={(e) => setSchedule({ ...schedule, dueDays: e.target.value })} />
              <Field id="schedule-end" label="Last invoice by (optional)" type="date" min={schedule.startOn} value={schedule.endOn} onChange={(e) => setSchedule({ ...schedule, endOn: e.target.value })} />
              <label className="flex items-center gap-2 text-[12px] text-ink-700 sm:col-span-2">
                <input type="checkbox" checked={schedule.autoSend} onChange={(e) => setSchedule({ ...schedule, autoSend: e.target.checked })} />
                Email each invoice to the customer when it is issued
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className="text-[11.5px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground">
              {busy ? "Saving…" : recurring ? "Save schedule" : mode === "edit" ? "Save changes" : "Create invoice"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ onClose, country }: { onClose: () => void; country?: string }) {
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);
  useEffect(() => {
    void api<InvoiceSettings>("/invoices/settings")
      .then(setSettings)
      .catch((error) => toast.error(errorMessage(error)));
  }, []);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Payment details"
      description="Shown on every invoice and its customer link, so customers know where to send money."
      submitLabel="Save"
      onSubmit={async () => {
        if (!settings) return;
        await api("/invoices/settings", { method: "PUT", body: JSON.stringify(settings) });
        toast.success("Payment details saved.");
      }}
    >
      {!settings ? (
        <p className="text-[12px] text-ink-400">Loading…</p>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="settings-instructions">How to pay you</Label>
            <Textarea
              id="settings-instructions"
              rows={5}
              maxLength={2000}
              value={settings.payment_instructions}
              placeholder={
                country === "KE"
                  ? "Bank: …\nAccount name: …\nAccount number: …\nM-Pesa paybill: …"
                  : "Bank: …\nAccount name: …\nAccount number or IBAN: …\nSWIFT/BIC: …\nMobile money: …"
              }
              onChange={(e) => setSettings({ ...settings, payment_instructions: e.target.value })}
              className="font-mono text-[11.5px]"
            />
            <p className="text-[10.5px] text-ink-400">Each invoice adds its own payment reference, so payments are matched automatically.</p>
          </div>
          <Field
            id="settings-footer"
            label="Footer (optional)"
            maxLength={500}
            placeholder="Registered business number, tax ID, thank-you note"
            value={settings.invoice_footer}
            onChange={(e) => setSettings({ ...settings, invoice_footer: e.target.value })}
          />
          <label className="flex items-start gap-2 text-[12px] text-ink-700">
            <input type="checkbox" className="mt-0.5" checked={settings.reminders_enabled} onChange={(e) => setSettings({ ...settings, reminders_enabled: e.target.checked })} />
            <span>
              Email customers a reminder when an invoice is overdue: 1, 7 and 14 days after the due date. Only customers with an email address,
              and only while the invoice is unpaid.
            </span>
          </label>
          <p className="text-[10.5px] text-ink-400">Next invoice number: {settings.next_invoice_number}</p>
        </>
      )}
    </FormDialog>
  );
}
