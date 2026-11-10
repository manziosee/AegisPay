"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, FileCheck2, Plus, RefreshCw, ShieldCheck, Upload, WalletCards, WifiOff, X } from "lucide-react";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { api, apiBlob, apiIdempotent, downloadBlob, errorMessage, idempotencyKey, type ApiError } from "@/lib/api";
import { listFinanceDrafts, removeFinanceDraft, saveFinanceDraft, type FinanceCommitmentDraft } from "@/lib/finance-drafts";
import { currencyFractionDigits, formatDate, formatDateTime, formatMinor, majorToMinor } from "@/lib/format";
import { isAdmin } from "@/lib/roles";
import type { AdvanceSettlement, FinanceCommitment, FinanceCommitmentInput, FinanceEvidence, FinanceFund, FinanceQueueItem, StaffAdvance } from "@/lib/types";

type ListResult<T> = { data: T[] };

function minorOrZero(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  if (Number(value) === 0) return 0;
  return majorToMinor(value, currency);
}

function id() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function FinancePlansPage() {
  const { session, role } = useSession();
  const organizationId = session?.organization_id ?? "";
  const admin = isAdmin(role ?? undefined);
  const [funds, setFunds] = useState<FinanceFund[]>([]);
  const [commitments, setCommitments] = useState<FinanceCommitment[]>([]);
  const [advances, setAdvances] = useState<StaffAdvance[]>([]);
  const [queue, setQueue] = useState<FinanceQueueItem[]>([]);
  const [drafts, setDrafts] = useState<FinanceCommitmentDraft[]>([]);
  const [settlements, setSettlements] = useState<Record<string, AdvanceSettlement[]>>({});
  const [evidence, setEvidence] = useState<Record<string, FinanceEvidence[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [online, setOnline] = useState(true);
  const [loadError, setLoadError] = useState("");
  const syncing = useRef(false);

  const activeFunds = useMemo(() => funds.filter((fund) => fund.status === "active"), [funds]);
  const workspaceDrafts = useMemo(
    () => drafts.filter((draft) => draft.organizationId === organizationId),
    [drafts, organizationId]
  );
  const otherWorkspaceDraftCount = drafts.length - workspaceDrafts.length;

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setLoadError("");
    try {
      const [fundResult, commitmentResult, advanceResult, queueResult] = await Promise.all([
        api<ListResult<FinanceFund>>("/finance-plans/funds"),
        api<ListResult<FinanceCommitment>>("/finance-plans/commitments"),
        api<ListResult<StaffAdvance>>("/finance-plans/advances"),
        api<ListResult<FinanceQueueItem>>("/finance-plans/queue")
      ]);
      setFunds(fundResult.data);
      setCommitments(commitmentResult.data);
      setAdvances(advanceResult.data);
      setQueue(queueResult.data);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  const reloadDrafts = useCallback(async () => {
    try {
      setDrafts(await listFinanceDrafts());
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  const syncQueued = useCallback(async () => {
    if (!organizationId || typeof navigator === "undefined" || !navigator.onLine || syncing.current) return;
    syncing.current = true;
    setBusy("sync");
    try {
      const current = await listFinanceDrafts();
      for (const draft of current.filter((item) => item.organizationId === organizationId)) {
        try {
          await api<{ id: string }>("/finance-plans/commitments", {
            method: "POST",
            headers: { "Idempotency-Key": draft.idempotencyKey },
            body: JSON.stringify(draft.payload)
          });
          await removeFinanceDraft(draft.id);
        } catch (error) {
          const message = errorMessage(error);
          await saveFinanceDraft({ ...draft, error: message });
          if ((error as ApiError).status === 0) break;
        }
      }
      await reloadDrafts();
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      syncing.current = false;
      setBusy("");
    }
  }, [organizationId, refresh, reloadDrafts]);

  useEffect(() => {
    void refresh();
    void reloadDrafts();
    setOnline(navigator.onLine);
    const handleOnline = () => {
      setOnline(true);
      void syncQueued();
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refresh, reloadDrafts, syncQueued]);

  async function submitFund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currency = String(form.get("currency") ?? "").trim().toUpperCase();
    const allocated = majorToMinor(String(form.get("allocated") ?? ""), currency);
    if (!allocated || !currency) {
      toast.error("Enter a positive allocation and a valid currency.");
      return;
    }
    const payload = {
      name: String(form.get("name") ?? "").trim(),
      fund_type: String(form.get("fund_type") ?? "general"),
      donor_name: String(form.get("donor_name") ?? "").trim(),
      project_code: String(form.get("project_code") ?? "").trim(),
      restriction_note: String(form.get("restriction_note") ?? "").trim(),
      currency,
      allocated_minor: allocated,
      period_start: String(form.get("period_start") ?? ""),
      period_end: String(form.get("period_end") ?? "")
    };
    setBusy("fund");
    try {
      await apiIdempotent("/finance-plans/funds", payload);
      formElement.reset();
      toast.success("Fund created.");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function persistOfflineDraft(payload: FinanceCommitmentInput, key: string) {
    const draft: FinanceCommitmentDraft = {
      id: id(),
      organizationId,
      payload,
      idempotencyKey: key,
      createdAt: new Date().toISOString()
    };
    await saveFinanceDraft(draft);
    await reloadDrafts();
    toast.success("Saved on this device. It will sync when this workspace is online.");
  }

  async function submitCommitment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const fund = activeFunds.find((item) => item.id === String(form.get("fund_id") ?? ""));
    if (!fund) {
      toast.error("Choose an active fund first.");
      return;
    }
    const amount = majorToMinor(String(form.get("amount") ?? ""), fund.currency);
    if (!amount) {
      toast.error("Enter a valid commitment amount.");
      return;
    }
    const payload: FinanceCommitmentInput = {
      fund_id: fund.id,
      commitment_type: String(form.get("commitment_type") ?? "supplier") as FinanceCommitmentInput["commitment_type"],
      title: String(form.get("title") ?? "").trim(),
      beneficiary_name: String(form.get("beneficiary_name") ?? "").trim(),
      amount_minor: amount,
      currency: fund.currency,
      due_date: String(form.get("due_date") ?? "")
    };
    const key = idempotencyKey();
    if (!navigator.onLine) {
      try {
        await persistOfflineDraft(payload, key);
        formElement.reset();
      } catch (error) {
        toast.error(errorMessage(error));
      }
      return;
    }
    setBusy("commitment");
    try {
      await api<{ id: string }>("/finance-plans/commitments", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify(payload)
      });
      formElement.reset();
      toast.success("Commitment recorded and budget reserved.");
      await refresh();
    } catch (error) {
      if ((error as ApiError).status === 0) {
        try {
          await persistOfflineDraft(payload, key);
          formElement.reset();
        } catch (storageError) {
          toast.error(errorMessage(storageError));
        }
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy("");
    }
  }

  async function linkPayout(commitment: FinanceCommitment) {
    setBusy(commitment.id);
    try {
      await apiIdempotent(`/finance-plans/commitments/${commitment.id}/link-payout`, {
        note: "Budget commitment sent to the bank approval workflow."
      });
      toast.success("Payout request created. It is not marked paid until matched in a bank statement.");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function submitAdvance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const fund = activeFunds.find((item) => item.id === String(form.get("fund_id") ?? ""));
    if (!fund) {
      toast.error("Choose an active fund first.");
      return;
    }
    const amount = majorToMinor(String(form.get("amount") ?? ""), fund.currency);
    if (!amount) {
      toast.error("Enter a valid advance amount.");
      return;
    }
    const payload = {
      fund_id: fund.id,
      staff_name: String(form.get("staff_name") ?? "").trim(),
      purpose: String(form.get("purpose") ?? "").trim(),
      amount_minor: amount,
      currency: fund.currency,
      note: String(form.get("note") ?? "").trim()
    };
    setBusy("advance");
    try {
      await apiIdempotent("/finance-plans/advances", payload);
      formElement.reset();
      toast.success("Advance recorded as awaiting payout. Reconcile the bank statement before settlement.");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function submitSettlement(event: FormEvent<HTMLFormElement>, advance: StaffAdvance) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const used = minorOrZero(String(form.get("used") ?? ""), advance.currency);
    const returned = minorOrZero(String(form.get("returned") ?? ""), advance.currency);
    if (used === null || returned === null || used + returned <= 0) {
      toast.error("Enter the amount used and/or returned.");
      return;
    }
    setBusy(advance.id);
    try {
      await apiIdempotent(`/finance-plans/advances/${advance.id}/settlements`, {
        used_minor: used,
        returned_minor: returned,
        note: String(form.get("note") ?? "").trim()
      });
      toast.success("Settlement submitted for an independent reviewer.");
      await loadAdvanceSettlements(advance.id);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function loadAdvanceSettlements(advanceId: string) {
    try {
      const result = await api<ListResult<AdvanceSettlement>>(`/finance-plans/advances/${advanceId}/settlements`);
      setSettlements((current) => ({ ...current, [advanceId]: result.data }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function reviewSettlement(item: FinanceQueueItem, decision: "approve" | "reject") {
    if (!item.advance_id) return;
    setBusy(item.id);
    try {
      await apiIdempotent(`/finance-plans/advances/${item.advance_id}/settlements/${item.id}/review`, {
        decision,
        note: decision === "approve" ? "Supporting evidence and totals reviewed." : "Please correct the settlement and resubmit."
      });
      toast.success(`Settlement ${decision === "approve" ? "approved" : "rejected"}.`);
      await refresh();
      await loadAdvanceSettlements(item.advance_id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>, resourceType: "commitment" | "advance" | "settlement", resourceId: string) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("resource_type", resourceType);
    form.set("resource_id", resourceId);
    setBusy(`evidence-${resourceId}`);
    try {
      const saved = await api<{ id: string }>("/finance-plans/evidence", { method: "POST", body: form });
      const key = `${resourceType}:${resourceId}`;
      const result = await api<ListResult<FinanceEvidence>>(`/finance-plans/evidence?resource_type=${resourceType}&resource_id=${encodeURIComponent(resourceId)}`);
      setEvidence((current) => ({ ...current, [key]: result.data }));
      formElement.reset();
      toast.success(`Evidence uploaded (${saved.id}).`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  const loadEvidence = useCallback(async (resourceType: "commitment" | "advance" | "settlement", resourceId: string) => {
    const key = `${resourceType}:${resourceId}`;
    if (evidence[key]) return;
    try {
      const result = await api<ListResult<FinanceEvidence>>(`/finance-plans/evidence?resource_type=${resourceType}&resource_id=${encodeURIComponent(resourceId)}`);
      setEvidence((current) => ({ ...current, [key]: result.data }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [evidence]);

  async function downloadEvidence(file: FinanceEvidence) {
    try {
      const blob = await apiBlob(`/finance-plans/evidence/${file.id}`);
      downloadBlob(blob, file.file_name);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function closeFund(fund: FinanceFund) {
    if (!window.confirm(`Close "${fund.name}"? It cannot be reopened, and new commitments will be blocked.`)) return;
    setBusy(fund.id);
    try {
      await apiIdempotent(`/finance-plans/funds/${fund.id}/close`, { note: "Fund closed after review of available commitments." });
      toast.success("Fund closed.");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function removeDraft(draft: FinanceCommitmentDraft) {
    try {
      await removeFinanceDraft(draft.id);
      await reloadDrafts();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const fractionDigits = activeFunds[0] ? currencyFractionDigits(activeFunds[0].currency) : 2;
  const amountStep = (currency: string) => (10 ** -currencyFractionDigits(currency)).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Funds and budgets"
        description="Track restricted and general funds, reserve planned spend, and connect approved requests to bank evidence. AegisPay records workflows; it never moves money."
        actions={
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${online ? "border-mint/30 bg-mint/5 text-ink-700" : "border-amber/40 bg-amber/10 text-amber-900"}`}>
            {online ? <Check className="size-4 text-mint" /> : <WifiOff className="size-4" />}
            {online ? "Online" : "Offline"}
          </div>
        }
      />

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-coral/30 bg-coral/5 p-4 text-[13px] text-ink-700">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Control health"
          description="Work items prioritized by urgency, not just by creation date."
          action={<Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw className="size-3.5" />Refresh</Button>}
        />
        {queue.length === 0 ? (
          <EmptyState icon={ShieldCheck} title={loading ? "Checking controls…" : "No urgent finance work"} text="Overdue payout approvals, pending advance reviews and statement exceptions will appear here." />
        ) : (
          <div className="divide-y divide-border">
            {queue.map((item) => (
              <div key={`${item.type}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${item.priority === 1 ? "bg-coral/10 text-coral" : "bg-amber/10 text-amber-800"}`}>
                    <CircleAlert className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-ink-900">{item.reference}</p>
                    <p className="mt-0.5 text-[12px] text-ink-500">{item.reason}</p>
                    {item.created_at && <p className="mt-1 text-[10.5px] text-ink-400">{formatDateTime(item.created_at)}</p>}
                  </div>
                </div>
                {item.type === "advance_settlement" && admin ? (
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy === item.id} onClick={() => void reviewSettlement(item, "approve")}><Check className="size-3.5" />Approve</Button>
                    <Button variant="outline" size="sm" disabled={busy === item.id} onClick={() => void reviewSettlement(item, "reject")}><X className="size-3.5" />Reject</Button>
                  </div>
                ) : item.type === "payout_approval" ? (
                  <Link href="/app/money" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">Review payout<ArrowRight className="size-3.5" /></Link>
                ) : (
                  <Link href="/app/reconciliation" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">Review exceptions<ArrowRight className="size-3.5" /></Link>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Funds and remaining budget" description="Available = allocation − active commitments − recorded spend. Each fund keeps its own currency and restrictions." />
        {funds.length === 0 && !loading ? (
          <EmptyState icon={WalletCards} title="No funds recorded" text="Create a general, restricted, grant, project, or household fund to begin tracking planned and actual use." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[12px]">
              <thead className="bg-paper-muted text-[10.5px] uppercase tracking-wide text-ink-400">
                <tr><th className="px-5 py-3 font-medium">Fund</th><th className="px-4 py-3 font-medium">Allocation</th><th className="px-4 py-3 font-medium">Committed</th><th className="px-4 py-3 font-medium">Spent</th><th className="px-4 py-3 font-medium">Available</th><th className="px-5 py-3" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {funds.map((fund) => {
                  const percentage = fund.allocated_minor > 0 ? Math.min(100, Math.max(0, ((fund.committed_minor + fund.spent_minor) / fund.allocated_minor) * 100)) : 0;
                  return (
                    <tr key={fund.id} className="align-top">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-ink-900">{fund.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-500">
                          <span className="capitalize">{fund.fund_type.replace("_", " ")}</span>
                          {fund.donor_name && <span>· {fund.donor_name}</span>}
                          {fund.project_code && <span>· {fund.project_code}</span>}
                          <StatusBadge status={fund.status} />
                        </div>
                        {fund.restriction_note && <p className="mt-1 max-w-[360px] text-[10.5px] text-ink-500">{fund.restriction_note}</p>}
                        {(fund.period_start || fund.period_end) && <p className="mt-1 text-[10px] text-ink-400">{fund.period_start ? formatDate(fund.period_start) : "Any start"} – {fund.period_end ? formatDate(fund.period_end) : "No end date"}</p>}
                        <div className="mt-2 h-1.5 w-full max-w-[240px] overflow-hidden rounded-full bg-paper-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} /></div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 font-medium">{formatMinor(fund.allocated_minor, fund.currency)}</td>
                      <td className="whitespace-nowrap px-4 py-4 text-ink-600">{formatMinor(fund.committed_minor, fund.currency)}</td>
                      <td className="whitespace-nowrap px-4 py-4 text-ink-600">{formatMinor(fund.spent_minor, fund.currency)}</td>
                      <td className="whitespace-nowrap px-4 py-4 font-semibold text-ink-900">{formatMinor(fund.available_minor, fund.currency)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-right">{admin && fund.status === "active" && <Button variant="outline" size="sm" disabled={busy === fund.id} onClick={() => void closeFund(fund)}>Close</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Create a fund" description="Record an allocation and its restrictions. Values are budgets, not bank balances." />
          <form onSubmit={submitFund} className="grid gap-3 p-5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="fund-name">Fund name</Label><Input id="fund-name" name="name" required minLength={2} maxLength={120} placeholder="Community health grant" /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-type">Fund type</Label><select id="fund-type" name="fund_type" className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]"><option value="general">General</option><option value="restricted">Restricted</option><option value="grant">Grant</option><option value="project">Project</option><option value="household">Household</option></select></div>
            <div className="space-y-1.5"><Label htmlFor="fund-currency">Currency</Label><Input id="fund-currency" name="currency" defaultValue="RWF" required minLength={3} maxLength={3} className="uppercase" /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-allocation">Allocated amount</Label><Input id="fund-allocation" name="allocated" type="number" min="0.01" step="0.01" required placeholder={fractionDigits === 0 ? "0" : "0.00"} /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-donor">Donor / source</Label><Input id="fund-donor" name="donor_name" maxLength={160} /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-project">Project code</Label><Input id="fund-project" name="project_code" maxLength={80} /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-start">Period starts</Label><Input id="fund-start" name="period_start" type="date" /></div>
            <div className="space-y-1.5"><Label htmlFor="fund-end">Period ends</Label><Input id="fund-end" name="period_end" type="date" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="fund-restrictions">Restriction / permitted use</Label><textarea id="fund-restrictions" name="restriction_note" maxLength={1000} rows={2} className="w-full rounded-md border border-input bg-background px-3 py-2 text-[12px]" placeholder="Required for restricted and grant funds" /></div>
            <Button className="sm:col-span-2" disabled={busy === "fund"}><Plus className="size-4" />{busy === "fund" ? "Creating…" : "Create fund"}</Button>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Reserve a budget commitment" description="A commitment reduces the available budget immediately. It is not a payment or proof of settlement." />
          <form onSubmit={submitCommitment} className="grid gap-3 p-5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="commitment-fund">Fund</Label><select id="commitment-fund" name="fund_id" required disabled={activeFunds.length === 0} className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]">{activeFunds.length === 0 ? <option value="">Create an active fund first</option> : activeFunds.map((fund) => <option key={fund.id} value={fund.id}>{fund.name} · {formatMinor(fund.available_minor, fund.currency)} available</option>)}</select></div>
            <div className="space-y-1.5"><Label htmlFor="commitment-type">Type</Label><select id="commitment-type" name="commitment_type" className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]"><option value="supplier">Supplier</option><option value="operating">Operating</option></select></div>
            <div className="space-y-1.5"><Label htmlFor="commitment-amount">Amount</Label><Input id="commitment-amount" name="amount" type="number" min={amountStep(activeFunds[0]?.currency ?? "USD")} step={amountStep(activeFunds[0]?.currency ?? "USD")} required /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="commitment-title">Purpose / description</Label><Input id="commitment-title" name="title" required minLength={2} maxLength={160} /></div>
            <div className="space-y-1.5"><Label htmlFor="commitment-beneficiary">Supplier / beneficiary</Label><Input id="commitment-beneficiary" name="beneficiary_name" maxLength={160} /></div>
            <div className="space-y-1.5"><Label htmlFor="commitment-due">Expected date</Label><Input id="commitment-due" name="due_date" type="date" /></div>
            <Button className="sm:col-span-2" disabled={busy === "commitment" || activeFunds.length === 0}><Plus className="size-4" />{busy === "commitment" ? "Saving…" : "Reserve commitment"}</Button>
            <p className="text-[11px] leading-relaxed text-ink-500 sm:col-span-2">When offline, commitments are saved only in this browser and remain visibly unsynced until the server confirms them.</p>
          </form>
        </Panel>
      </div>

      {drafts.length > 0 && (
        <Panel>
          <PanelHeader
            title={`Offline drafts · ${workspaceDrafts.length}`}
            description="Saved on this device only. A draft does not reserve server budget until sync succeeds."
            action={<Button variant="outline" size="sm" disabled={!online || busy === "sync"} onClick={() => void syncQueued()}><RefreshCw className="size-3.5" />Sync drafts</Button>}
          />
          <div className="divide-y divide-border">
            {workspaceDrafts.map((draft) => (
              <div key={draft.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold text-ink-900">{draft.payload.title} · {formatMinor(draft.payload.amount_minor, draft.payload.currency)}</p>
                  <p className="mt-0.5 text-[10.5px] text-ink-500">{draft.error ? `Sync needs attention: ${draft.error}` : `Waiting to sync · saved ${formatDateTime(draft.createdAt)}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={draft.error ? "sync needs attention" : "offline draft"} />
                  <Button variant="ghost" size="sm" aria-label="Remove offline draft" onClick={() => void removeDraft(draft)}><X className="size-4" /></Button>
                </div>
              </div>
            ))}
          </div>
          {workspaceDrafts.length === 0 && <p className="px-5 py-4 text-[11px] text-ink-500">There are no drafts for this workspace.</p>}
          {otherWorkspaceDraftCount > 0 && <p className="px-5 pb-4 text-[11px] text-ink-500">{otherWorkspaceDraftCount} draft(s) belong to another workspace and will not sync here.</p>}
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Budget-to-bank evidence trail" description="Planned → approval → manual bank action → statement match. A record is never called paid just because it was created or exported." />
        {commitments.length === 0 && !loading ? (
          <EmptyState icon={FileCheck2} title="No commitments yet" text="Create a budget commitment to reserve funds and follow it through review and bank-statement confirmation." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-[12px]">
              <thead className="bg-paper-muted text-[10.5px] uppercase tracking-wide text-ink-400"><tr><th className="px-5 py-3 font-medium">Request</th><th className="px-4 py-3 font-medium">Fund</th><th className="px-4 py-3 font-medium">Amount</th><th className="px-4 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Evidence / action</th></tr></thead>
              <tbody className="divide-y divide-border">
                {commitments.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="px-5 py-4"><p className="font-semibold text-ink-900">{item.title}</p><p className="mt-1 text-[10.5px] text-ink-500">{item.beneficiary_name || item.commitment_type} · due {item.due_date ? formatDate(item.due_date) : "not set"}</p></td>
                    <td className="px-4 py-4">{item.fund_name}</td>
                    <td className="whitespace-nowrap px-4 py-4 font-medium">{formatMinor(item.amount_minor, item.currency)}</td>
                    <td className="px-4 py-4"><StatusBadge status={item.status} />{item.payout_id && <p className="mt-1 text-[10px] text-ink-400">Payout: {item.payout_status?.replaceAll("_", " ") || "linked"}</p>}</td>
                    <td className="min-w-[220px] px-5 py-3">
                      <EvidenceControl resourceType="commitment" resourceId={item.id} busy={busy} files={evidence[`commitment:${item.id}`]} onLoad={loadEvidence} onUpload={uploadEvidence} onDownload={downloadEvidence} />
                      {item.status === "planned" && item.beneficiary_name && <Button className="mt-2 h-8" size="sm" disabled={busy === item.id} onClick={() => void linkPayout(item)}><ArrowRight className="size-3.5" />Send to payout approvals</Button>}
                      {item.status === "planned" && !item.beneficiary_name && <p className="mt-2 text-[10.5px] text-ink-500">A beneficiary is needed to create a payout request.</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <Panel>
          <PanelHeader title="Staff advance" description="Create an approved payout workflow for an advance; collect receipts and submit a settlement only after the bank statement confirms it." />
          <form onSubmit={submitAdvance} className="grid gap-3 p-5">
            <div className="space-y-1.5"><Label htmlFor="advance-fund">Fund</Label><select id="advance-fund" name="fund_id" required disabled={activeFunds.length === 0} className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]">{activeFunds.length === 0 ? <option value="">Create an active fund first</option> : activeFunds.map((fund) => <option key={fund.id} value={fund.id}>{fund.name} · {formatMinor(fund.available_minor, fund.currency)} available</option>)}</select></div>
            <div className="space-y-1.5"><Label htmlFor="advance-staff">Staff member</Label><Input id="advance-staff" name="staff_name" required minLength={2} maxLength={160} /></div>
            <div className="space-y-1.5"><Label htmlFor="advance-purpose">Purpose</Label><Input id="advance-purpose" name="purpose" required minLength={3} maxLength={500} placeholder="Field travel and accommodation" /></div>
            <div className="space-y-1.5"><Label htmlFor="advance-amount">Amount</Label><Input id="advance-amount" name="amount" type="number" min={amountStep(activeFunds[0]?.currency ?? "USD")} step={amountStep(activeFunds[0]?.currency ?? "USD")} required /></div>
            <div className="space-y-1.5"><Label htmlFor="advance-note">Review context</Label><Input id="advance-note" name="note" maxLength={500} /></div>
            <Button disabled={busy === "advance" || activeFunds.length === 0}><Plus className="size-4" />{busy === "advance" ? "Creating…" : "Create advance payout"}</Button>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Advances and settlement" description="Each settlement needs an independent owner/admin review. The amount spent becomes budget spend; returned funds are released." />
          {advances.length === 0 && !loading ? (
            <EmptyState icon={WalletCards} title="No staff advances" text="Advances are tracked here separately from ordinary supplier commitments." />
          ) : (
            <div className="divide-y divide-border">
              {advances.map((advance) => {
                const history = settlements[advance.id] ?? [];
                const pending = history.some((item) => item.status === "pending_review");
                return (
                  <div key={advance.id} className="space-y-3 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><p className="text-[13px] font-semibold text-ink-900">{advance.staff_name} · {advance.purpose}</p><p className="mt-1 text-[11px] text-ink-500">{advance.fund_name} · {advance.payout_reference} · {formatMinor(advance.amount_minor, advance.currency)}</p></div>
                      <div className="text-right"><StatusBadge status={advance.status === "awaiting_payout" ? "awaiting bank statement" : advance.status} /><p className="mt-1 text-[10.5px] text-ink-500">Payout: {advance.payout_status.replaceAll("_", " ")}</p></div>
                    </div>
                    {advance.payout_status === "statement_confirmed" && (
                      <div className="rounded-lg bg-paper-muted p-3 text-[11px] text-ink-600">
                        Outstanding {formatMinor(advance.remaining_minor, advance.currency)} · approved use {formatMinor(advance.used_minor, advance.currency)}
                      </div>
                    )}
                    <EvidenceControl resourceType="advance" resourceId={advance.id} busy={busy} files={evidence[`advance:${advance.id}`]} onLoad={loadEvidence} onUpload={uploadEvidence} onDownload={downloadEvidence} />
                    {advance.status === "outstanding" && !pending && advance.remaining_minor > 0 && (
                      <form onSubmit={(event) => void submitSettlement(event, advance)} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
                        <div className="space-y-1"><Label htmlFor={`used-${advance.id}`} className="text-[11px]">Amount used</Label><Input id={`used-${advance.id}`} name="used" type="number" min="0" max={advance.remaining_minor / 10 ** currencyFractionDigits(advance.currency)} step={amountStep(advance.currency)} required /></div>
                        <div className="space-y-1"><Label htmlFor={`returned-${advance.id}`} className="text-[11px]">Amount returned</Label><Input id={`returned-${advance.id}`} name="returned" type="number" min="0" step={amountStep(advance.currency)} defaultValue="0" required /></div>
                        <div className="space-y-1 sm:col-span-2"><Label htmlFor={`settlement-note-${advance.id}`} className="text-[11px]">Settlement explanation</Label><Input id={`settlement-note-${advance.id}`} name="note" required minLength={3} maxLength={1000} placeholder="Receipts attached; unused balance returned" /></div>
                        <Button size="sm" className="sm:col-span-2" disabled={busy === advance.id}><FileCheck2 className="size-3.5" />Submit for review</Button>
                      </form>
                    )}
                    {pending && <p className="rounded-lg bg-amber/10 px-3 py-2 text-[11px] text-amber-900">A settlement is awaiting independent review.</p>}
                    {history.length > 0 ? <SettlementHistory items={history} currency={advance.currency} busy={busy} onLoadEvidence={loadEvidence} onUploadEvidence={uploadEvidence} onDownloadEvidence={downloadEvidence} evidence={evidence} /> : <Button variant="outline" size="sm" onClick={() => void loadAdvanceSettlements(advance.id)}>Load settlement history</Button>}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-paper-muted/50 px-4 py-3 text-[11px] text-ink-500">
        <p>Evidence files are limited to 4 MiB each and are hashed. Month-end audit packs include finance records and uploaded evidence.</p>
        <Link href="/app/audit" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">Open audit evidence<ArrowDownToLine className="size-3.5" /></Link>
      </div>
    </div>
  );
}

function EvidenceControl({
  resourceType,
  resourceId,
  busy,
  files,
  onLoad,
  onUpload,
  onDownload
}: {
  resourceType: "commitment" | "advance" | "settlement";
  resourceId: string;
  busy: string;
  files?: FinanceEvidence[];
  onLoad: (type: "commitment" | "advance" | "settlement", id: string) => Promise<void>;
  onUpload: (event: FormEvent<HTMLFormElement>, type: "commitment" | "advance" | "settlement", id: string) => Promise<void>;
  onDownload: (file: FinanceEvidence) => Promise<void>;
}) {
  useEffect(() => {
    void onLoad(resourceType, resourceId);
  }, [onLoad, resourceId, resourceType]);
  return (
    <div className="space-y-2">
      <form onSubmit={(event) => void onUpload(event, resourceType, resourceId)} className="flex flex-wrap items-center gap-2">
        <Input aria-label={`Evidence file for ${resourceId}`} name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.zip" required className="h-8 min-w-[180px] text-[10.5px]" />
        <Input aria-label="Evidence note" name="note" maxLength={500} placeholder="Note (optional)" className="h-8 min-w-[120px] text-[10.5px]" />
        <Button size="sm" variant="outline" disabled={busy === `evidence-${resourceId}`}><Upload className="size-3.5" />Attach</Button>
      </form>
      {files?.map((file) => (
        <button key={file.id} type="button" onClick={() => void onDownload(file)} className="flex max-w-full items-center gap-1.5 text-left text-[10.5px] text-primary hover:underline">
          <ArrowDownToLine className="size-3 shrink-0" /><span className="truncate">{file.file_name}</span><span className="shrink-0 text-ink-400">· {Math.ceil(file.file_size / 1024)} KB</span>
        </button>
      ))}
    </div>
  );
}

function SettlementHistory({
  items,
  currency,
  busy,
  onLoadEvidence,
  onUploadEvidence,
  onDownloadEvidence,
  evidence
}: {
  items: AdvanceSettlement[];
  currency: string;
  busy: string;
  onLoadEvidence: (type: "commitment" | "advance" | "settlement", id: string) => Promise<void>;
  onUploadEvidence: (event: FormEvent<HTMLFormElement>, type: "commitment" | "advance" | "settlement", id: string) => Promise<void>;
  onDownloadEvidence: (file: FinanceEvidence) => Promise<void>;
  evidence: Record<string, FinanceEvidence[]>;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <div><p className="text-[11px] font-medium text-ink-800">{formatMinor(item.used_minor, currency)} used · {formatMinor(item.returned_minor, currency)} returned</p><p className="mt-0.5 text-[10px] text-ink-500">{item.note} · {formatDate(item.created_at)}</p></div>
          <div className="space-y-2">
            <StatusBadge status={item.status.replace("_", " ")} />
            <EvidenceControl resourceType="settlement" resourceId={item.id} busy={busy} files={evidence[`settlement:${item.id}`]} onLoad={onLoadEvidence} onUpload={onUploadEvidence} onDownload={onDownloadEvidence} />
          </div>
        </div>
      ))}
    </div>
  );
}
