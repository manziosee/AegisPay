"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Banknote, Download, FileUp, Loader2, Send, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, apiBlob, apiIdempotent, downloadBlob, errorMessage } from "@/lib/api";
import { formatDate, formatMinor, majorToMinor, minorHint } from "@/lib/format";
import type { BankPayout, BankRequest, Page } from "@/lib/types";

export default function MoneyPage() {
  const { session } = useSession();
  const { refresh } = useWorkspaceData();
  const [requests, setRequests] = useState<BankRequest[]>([]);
  const [payouts, setPayouts] = useState<BankPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [requestForm, setRequestForm] = useState({
    amount: "",
    currency: "RWF",
    description: "",
    due_date: ""
  });
  const [payoutForm, setPayoutForm] = useState({
    beneficiary_name: "",
    amount: "",
    currency: "RWF",
    description: ""
  });
  const [fileName, setFileName] = useState("");
  const [csv, setCSV] = useState("");
  const [statementBusy, setStatementBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [requestPage, payoutPage] = await Promise.all([
        api<Page<BankRequest>>("/bank-operations/requests"),
        api<Page<BankPayout>>("/bank-operations/payouts")
      ]);
      setRequests(requestPage.data ?? []);
      setPayouts(payoutPage.data ?? []);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const createRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const minor = majorToMinor(requestForm.amount, requestForm.currency);
    if (minor == null) {
      setFormError("Enter a positive amount in major units.");
      return;
    }
    setBusy("request");
    setFormError("");
    try {
      const result = await api<BankRequest>("/bank-operations/requests", {
        method: "POST",
        body: JSON.stringify({ ...requestForm, amount: minor })
      });
      setRequestForm({ amount: "", currency: requestForm.currency, description: "", due_date: "" });
      toast.success(
        `Payment request created with reference ${result.reference}. No funds have been received.`
      );
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const createPayout = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const minor = majorToMinor(payoutForm.amount, payoutForm.currency);
    if (minor == null) {
      setFormError("Enter a positive amount in major units.");
      return;
    }
    setBusy("payout");
    setFormError("");
    try {
      const result = await api<BankPayout>("/bank-operations/payouts", {
        method: "POST",
        body: JSON.stringify({ ...payoutForm, amount: minor })
      });
      setPayoutForm({ beneficiary_name: "", amount: "", currency: payoutForm.currency, description: "" });
      toast.success(
        result.status === "pending_approval"
          ? `Payout ${result.reference} is awaiting ${result.required_approvals ?? 1} approval(s); no bank transfer has been submitted.`
          : `Payout register entry prepared (${result.reference}); no bank transfer has been submitted.`
      );
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const chooseFile = async (file?: File) => {
    setCSV("");
    setFileName("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Choose a CSV statement file.");
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim() || text.length > 1024 * 1024) {
        toast.error("Choose a non-empty CSV file no larger than 1 MiB.");
        return;
      }
      setFileName(file.name);
      setCSV(text);
    } catch (error) {
      toast.error(`The selected statement could not be read: ${errorMessage(error)}`);
    }
  };

  const importStatement = async () => {
    if (!session || !csv || !fileName) return;
    setStatementBusy(true);
    try {
      const result = await apiIdempotent<{ id: string; matched_count: number; exception_count: number }>(
        "/reconciliation/imports/csv",
        { source_name: fileName, csv }
      );
      setCSV("");
      setFileName("");
      toast.success(
        `Statement imported. ${result.matched_count} lines matched; ${result.exception_count} need review.`
      );
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStatementBusy(false);
    }
  };

  const exportRegister = async () => {
    if (!session) return;
    setBusy("export");
    try {
      const blob = await apiBlob("/bank-operations/payouts/export", {
        method: "POST"
      });
      downloadBlob(blob, "aegispay-payout-register.csv");
      toast.success("Payout register exported for manual entry. It has not been submitted to your bank.");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const markSubmitted = async (payout: BankPayout) => {
    if (!session) return;
    const note = (notes[payout.id] ?? "").trim();
    if (!note) {
      toast.error("Add a note confirming the action in your bank portal.");
      return;
    }
    setBusy(payout.id);
    try {
      await api(`/bank-operations/payouts/${encodeURIComponent(payout.id)}/submit`, {
        method: "POST",
        body: JSON.stringify({ note })
      });
      setNotes((current) => ({ ...current, [payout.id]: "" }));
      toast.success("Recorded as submitted to bank; settlement is still awaiting a statement match.");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const reviewPayout = async (payout: BankPayout, action: "approve" | "reject") => {
    if (!session) return;
    const note = (notes[payout.id] ?? "").trim();
    if (!note) {
      toast.error("Add a note explaining the payout review decision.");
      return;
    }
    setBusy(payout.id);
    try {
      const result = await apiIdempotent<{ status: string; approvals_received: number; required_approvals: number }>(
        `/bank-operations/payouts/${encodeURIComponent(payout.id)}/${action}`,
        { note }
      );
      setNotes((current) => ({ ...current, [payout.id]: "" }));
      toast.success(
        action === "reject"
          ? "Payout rejected. It cannot be exported."
          : result.status === "prepared"
            ? "Payout has all required approvals and is ready for register export."
            : `Payout approval recorded (${result.approvals_received} of ${result.required_approvals}).`
      );
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <PageHeader
        title="Receive and send money"
        description="Keep payment requests, payout records and bank-statement evidence together. AegisPay records the workflow; your bank moves the funds."
      />

      {formError && (
        <p role="alert" className="mb-3 rounded-md border border-coral/20 bg-coral-soft px-3 py-2 text-[11.5px] text-[#a83422]">
          {formError}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Create a payment request"
            description="Share the reference and your own bank-transfer instructions outside AegisPay."
          />
          <form onSubmit={createRequest} className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="request-amount">Amount (major units)</Label>
                <Input
                  id="request-amount"
                  type="number"
                  min="0"
                  step="any"
                  value={requestForm.amount}
                  onChange={(event) => setRequestForm({ ...requestForm, amount: event.target.value })}
                  required
                  className="h-9 font-mono text-[12px]"
                />
                <p className="text-[10.5px] text-ink-400">{minorHint(requestForm.amount, requestForm.currency)}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="request-currency">Currency</Label>
                <Input
                  id="request-currency"
                  value={requestForm.currency}
                  onChange={(event) =>
                    setRequestForm({
                      ...requestForm,
                      currency: event.target.value.toUpperCase().slice(0, 3)
                    })
                  }
                  maxLength={3}
                  required
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="request-due">Due date</Label>
                <Input
                  id="request-due"
                  type="date"
                  value={requestForm.due_date}
                  onChange={(event) => setRequestForm({ ...requestForm, due_date: event.target.value })}
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="request-description">Description</Label>
                <Input
                  id="request-description"
                  value={requestForm.description}
                  onChange={(event) =>
                    setRequestForm({ ...requestForm, description: event.target.value })
                  }
                  maxLength={500}
                  className="h-9 text-[12px]"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10.5px] text-ink-400">Request creation does not receive money.</p>
              <Button
                type="submit"
                disabled={busy === "request"}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {busy === "request" ? "Creating…" : "Create request"}
              </Button>
            </div>
          </form>

          <div className="border-t border-border">
            <p className="px-5 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-400">
              Payment requests
            </p>
            {loading ? (
              <div className="space-y-2 px-5 pb-4">
                {[0, 1].map((index) => (
                  <div key={index} className="h-11 animate-pulse rounded-md bg-paper-muted" />
                ))}
              </div>
            ) : requests.length === 0 ? (
              <EmptyState
                icon={Banknote}
                title="No payment requests yet."
                text="Create a request to record a receivable reference."
                className="py-8"
              />
            ) : (
              <ul className="divide-y divide-border">
                {requests.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="font-mono text-[11.5px] text-ink-900">{item.reference}</p>
                      <p className="mt-0.5 truncate text-[10.5px] text-ink-400">
                        {item.description || "Payment request"} ·{" "}
                        {item.due_date ? `due ${item.due_date}` : "no due date"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-[11.5px] text-ink-900">
                        {formatMinor(item.amount, item.currency)}
                      </p>
                      <StatusBadge
                        status={item.status}
                        label={item.status === "statement_confirmed" ? "confirmed in statement" : undefined}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Prepare a payout register"
            description="Create a review record, then export a CSV for manual bank-portal entry."
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                disabled={busy === "export"}
                onClick={() => void exportRegister()}
              >
                <Download className="size-3.5" />
                {busy === "export" ? "Exporting…" : "Export prepared CSV"}
              </Button>
            }
          />
          <form onSubmit={createPayout} className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payout-beneficiary">Beneficiary</Label>
                <Input
                  id="payout-beneficiary"
                  value={payoutForm.beneficiary_name}
                  onChange={(event) =>
                    setPayoutForm({ ...payoutForm, beneficiary_name: event.target.value })
                  }
                  maxLength={160}
                  required
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payout-amount">Amount (major units)</Label>
                <Input
                  id="payout-amount"
                  type="number"
                  min="0"
                  step="any"
                  value={payoutForm.amount}
                  onChange={(event) => setPayoutForm({ ...payoutForm, amount: event.target.value })}
                  required
                  className="h-9 font-mono text-[12px]"
                />
                <p className="text-[10.5px] text-ink-400">{minorHint(payoutForm.amount, payoutForm.currency)}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payout-currency">Currency</Label>
                <Input
                  id="payout-currency"
                  value={payoutForm.currency}
                  onChange={(event) =>
                    setPayoutForm({
                      ...payoutForm,
                      currency: event.target.value.toUpperCase().slice(0, 3)
                    })
                  }
                  maxLength={3}
                  required
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payout-description">Description</Label>
                <Input
                  id="payout-description"
                  value={payoutForm.description}
                  onChange={(event) =>
                    setPayoutForm({ ...payoutForm, description: event.target.value })
                  }
                  maxLength={500}
                  className="h-9 text-[12px]"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10.5px] text-ink-400">No bank-account details are stored.</p>
              <Button
                type="submit"
                disabled={busy === "payout"}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {busy === "payout" ? "Preparing…" : "Prepare payout"}
              </Button>
            </div>
          </form>

          <div className="border-t border-border">
            <p className="px-5 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-400">
              Payout instructions
            </p>
            {payouts.length === 0 ? (
              <EmptyState
                icon={Send}
                title="No payout instructions yet."
                text="Prepared payout records appear here before CSV export."
                className="py-8"
              />
            ) : (
              <ul className="divide-y divide-border">
                {payouts.map((item) => (
                  <li key={item.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-medium text-ink-900">
                          {item.beneficiary_name}
                        </p>
                        <p className="mt-0.5 font-mono text-[10.5px] text-ink-400">{item.reference}</p>
                        <p className="mt-1 truncate text-[10.5px] text-ink-400">
                          {item.description || "Payout"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono text-[11.5px] text-ink-900">
                          {formatMinor(item.amount, item.currency)}
                        </p>
                        <StatusBadge status={item.status} />
                      </div>
                    </div>

                    {item.status === "pending_approval" && (
                      <div className="mt-3 space-y-2 rounded-lg border border-border bg-paper p-3">
                        <p className="text-[10.5px] text-amber">
                          {item.approvals_received ?? 0} of {item.required_approvals ?? 1} approvals
                        </p>
                        <Input
                          aria-label={`Payout review note for ${item.reference}`}
                          placeholder="Note explaining this review decision"
                          value={notes[item.id] ?? ""}
                          onChange={(event) =>
                            setNotes({ ...notes, [item.id]: event.target.value })
                          }
                          className="h-8 bg-card text-[11px]"
                        />
                        <div className="flex gap-2">
                          <Button
                            className="h-7 bg-primary text-[11px] font-semibold text-primary-foreground"
                            disabled={busy === item.id}
                            onClick={() => void reviewPayout(item, "approve")}
                          >
                            Approve payout
                          </Button>
                          <Button
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busy === item.id}
                            onClick={() => void reviewPayout(item, "reject")}
                          >
                            Reject payout
                          </Button>
                        </div>
                      </div>
                    )}

                    {item.status === "exported_for_manual_entry" && (
                      <div className="mt-3 space-y-2 rounded-lg border border-border bg-paper p-3">
                        <Input
                          aria-label={`Bank submission note for ${item.reference}`}
                          placeholder="Note confirming bank-portal entry"
                          value={notes[item.id] ?? ""}
                          onChange={(event) =>
                            setNotes({ ...notes, [item.id]: event.target.value })
                          }
                          className="h-8 bg-card text-[11px]"
                        />
                        <Button
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={busy === item.id}
                          onClick={() => void markSubmitted(item)}
                        >
                          Record submitted
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-border px-5 py-2.5 text-[10.5px] text-ink-400">
              CSV is a register, not a bank-executable payment file.
            </p>
          </div>
        </Panel>
      </div>

      <Panel id="statement" className="mt-4 scroll-mt-24">
        <PanelHeader
          title="Import a bank statement"
          description="CSV columns: reference, amount (major units) or amount_minor, currency, and optional date/provider_fee."
        />
        <div className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-2">
            <Label htmlFor="statement-csv">Statement CSV</Label>
            <label
              htmlFor="statement-csv"
              className="flex h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-paper text-center transition-colors hover:bg-paper-muted/70"
            >
              <Upload className="size-4 text-ink-400" />
              <span className="text-[11.5px] text-ink-500">
                {fileName || "Choose a CSV file (max 1 MiB)"}
              </span>
              {fileName && csv && (
                <span className="font-mono text-[10px] text-ink-400">
                  {csv.split(/\r\n|\r|\n/).filter(Boolean).length - 1} data lines
                </span>
              )}
              <input
                id="statement-csv"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </label>
            <p className="text-[10.5px] text-ink-400">
              {fileName
                ? `${fileName} · ${csv.split(/\r\n|\r|\n/).filter(Boolean).length - 1} data lines`
                : "Matching references confirm receipt only when the imported statement agrees."}
            </p>
          </div>
          <Button
            className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
            disabled={!csv || statementBusy}
            onClick={() => void importStatement()}
          >
            {statementBusy ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
            {statementBusy ? "Importing…" : "Import statement"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5">
          <p className="text-[10.5px] text-ink-400">
            Statement evidence is stored with the import; no funds are received by this action.
          </p>
          <Link href="/app/reconciliation" className="text-[11px] text-primary hover:text-primary/80">
            Open reconciliation
          </Link>
        </div>
      </Panel>

      <p className="mt-3 flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-400">
        <FileUp className="mt-0.5 size-3.5 shrink-0" />
        AegisPay stores the workflow and evidence. It does not hold funds, submit payments, or
        connect to a payment provider.
      </p>
    </div>
  );
}
