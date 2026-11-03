"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarRange,
  Download,
  FileCheck2,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useSession } from "@/components/providers/session-provider";
import { api, downloadBlob, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { canViewControls, isAdmin } from "@/lib/roles";
import type {
  AuditEntry,
  ClosePeriod,
  ControlHealth,
  Delegation,
  Page,
  Role
} from "@/lib/types";

const scenarios = [
  ["duplicate_statement_lines", "Duplicate statement lines"],
  ["mismatched_totals", "Statement total mismatch"],
  ["suspicious_transfer", "Suspicious transfer request"]
] as const;

function auditCsv(rows: AuditEntry[]) {
  const escape = (value: unknown) => {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    ["timestamp", "actor_id", "action", "resource_type", "resource_id", "metadata"],
    ...rows.map((row) => [
      row.created_at,
      row.actor_id,
      row.action,
      row.resource_type,
      row.resource_id,
      row.metadata
    ])
  ]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
}

export default function ControlsPage() {
  const { session, role } = useSession();
  const safeRole = (role ?? "auditor") as Role;
  const admin = isAdmin(safeRole);
  const allowed = canViewControls(safeRole);

  const [health, setHealth] = useState<ControlHealth>({});
  const [periods, setPeriods] = useState<ClosePeriod[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [periodForm, setPeriodForm] = useState({ period_start: "", period_end: "" });
  const [scenario, setScenario] = useState<string>(scenarios[0][0]);
  const [delegationForm, setDelegationForm] = useState({
    delegate_email: "",
    expires_at: "",
    note: ""
  });
  const [auditQuery, setAuditQuery] = useState("");
  const [periodError, setPeriodError] = useState("");

  const load = useCallback(async () => {
    if (!session || !allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [healthState, periodPage, auditPage, delegationResult] = await Promise.all([
        api<ControlHealth>("/bank-operations/health", session.access_token),
        api<Page<ClosePeriod>>("/bank-operations/periods", session.access_token),
        api<Page<AuditEntry>>("/audit-logs?limit=100", session.access_token),
        admin
          ? api<{ data: Delegation[] }>("/bank-operations/delegations", session.access_token)
          : Promise.resolve({ data: [] as Delegation[] })
      ]);
      setHealth(healthState);
      setPeriods(periodPage.data ?? []);
      setAudit(auditPage.data ?? []);
      setAuditCursor(auditPage.next_cursor ?? null);
      setDelegations(delegationResult.data ?? []);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [admin, allowed, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const createPeriod = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    if (!periodForm.period_start || !periodForm.period_end) {
      setPeriodError("Choose both dates for the close period.");
      return;
    }
    setBusy("period");
    setPeriodError("");
    try {
      await api("/bank-operations/periods", session.access_token, {
        method: "POST",
        body: JSON.stringify(periodForm)
      });
      setPeriodForm({ period_start: "", period_end: "" });
      toast.success("Period checklist created.");
      await load();
    } catch (error) {
      setPeriodError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const changePeriod = async (period: ClosePeriod, action: "close" | "reopen") => {
    if (!session) return;
    const note = (notes[period.id] ?? "").trim();
    if (!note) {
      toast.error(`A review note is required to ${action} this period.`);
      return;
    }
    setBusy(period.id);
    try {
      await api(`/bank-operations/periods/${encodeURIComponent(period.id)}/${action}`, session.access_token, {
        method: "POST",
        body: JSON.stringify({ note })
      });
      setNotes((current) => ({ ...current, [period.id]: "" }));
      toast.success(`Period ${action === "close" ? "closed" : "reopened"} with a recorded review note.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const simulate = async () => {
    if (!session) return;
    setBusy("scenario");
    try {
      const result = await api<{
        title?: string;
        result?: { title?: string };
        mode?: string;
        ledger_changed?: boolean;
        funds_moved?: boolean;
      }>("/bank-operations/scenarios/simulate", session.access_token, {
        method: "POST",
        body: JSON.stringify({ scenario_type: scenario })
      });
      const title = result.title ?? result.result?.title ?? "Scenario";
      toast.success(
        `${title} completed in simulation mode. No ledger changes or funds movement occurred.`
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const createDelegation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const expires = new Date(delegationForm.expires_at);
    if (!delegationForm.expires_at || Number.isNaN(expires.getTime()) || !delegationForm.note.trim()) {
      toast.error("Choose a valid expiry time and add a delegation note.");
      return;
    }
    setBusy("delegation");
    try {
      await api("/bank-operations/delegations", session.access_token, {
        method: "POST",
        body: JSON.stringify({
          ...delegationForm,
          expires_at: expires.toISOString()
        })
      });
      setDelegationForm({ delegate_email: "", expires_at: "", note: "" });
      toast.success("Approval delegation created with a time limit.");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const revokeDelegation = async (delegation: Delegation) => {
    if (!session) return;
    setBusy(delegation.id);
    try {
      await api(`/bank-operations/delegations/${encodeURIComponent(delegation.id)}/revoke`, session.access_token, {
        method: "POST",
        body: JSON.stringify({})
      });
      toast.success(`Approval delegation for ${delegation.delegate_email} revoked.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const loadMoreAudit = async () => {
    if (!session || !auditCursor) return;
    setAuditLoading(true);
    try {
      const page = await api<Page<AuditEntry>>(
        `/audit-logs?limit=100&cursor=${encodeURIComponent(auditCursor)}`,
        session.access_token
      );
      setAudit((current) => [...current, ...(page.data ?? [])]);
      setAuditCursor(page.next_cursor ?? null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAuditLoading(false);
    }
  };

  const filteredAudit = useMemo(() => {
    const needle = auditQuery.trim().toLowerCase();
    if (!needle) return audit;
    return audit.filter((entry) =>
      `${entry.actor_id ?? ""} ${entry.action} ${entry.resource_type} ${entry.resource_id}`
        .toLowerCase()
        .includes(needle)
    );
  }, [audit, auditQuery]);

  const exportAudit = () => {
    const blob = new Blob([auditCsv(filteredAudit)], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, "aegispay-audit-log.csv");
    toast.success("Audit page exported.");
  };

  if (!allowed) {
    return (
      <Panel>
        <EmptyState
          icon={ShieldCheck}
          title="Controls are not available for this role"
          text="Finance operators, auditors, owners and admins can view close and control records."
        />
      </Panel>
    );
  }

  const healthItems = [
    ["Open exceptions", health.open_reconciliation_exceptions],
    ["Pending approvals", health.pending_approvals],
    ["Open periods", health.open_periods],
    ["Payouts awaiting statements", health.payouts_awaiting_statement]
  ] as const;

  return (
    <div>
      <PageHeader
        title="Close and controls"
        description="Prioritize unresolved work, record reviewer decisions and keep each period close auditable."
        actions={
          <Button asChild variant="outline" className="h-9 border-border bg-card text-[12.5px]">
            <Link href="/app/reconciliation">
              Open exceptions <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 divide-border rounded-xl border border-border bg-card sm:grid-cols-4 sm:divide-x">
        {healthItems.map(([label, value]) => (
          <div key={label} className="px-4 py-3">
            <p className="text-[11px] text-ink-400">{label}</p>
            <p className="mt-1 font-mono text-[20px] leading-none text-ink-950">
              {typeof value === "number" ? value : "—"}
            </p>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <Panel>
          <PanelHeader
            title="Period close checklist"
            description="Closing is blocked while statement exceptions or approvals remain unresolved. The end date is exclusive."
          />
          <form onSubmit={createPeriod} className="space-y-3 border-b border-border p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="period-start">Start date</Label>
                <Input
                  id="period-start"
                  type="date"
                  value={periodForm.period_start}
                  onChange={(event) => setPeriodForm({ ...periodForm, period_start: event.target.value })}
                  required
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-end">End date (exclusive)</Label>
                <Input
                  id="period-end"
                  type="date"
                  value={periodForm.period_end}
                  onChange={(event) => setPeriodForm({ ...periodForm, period_end: event.target.value })}
                  required
                  className="h-9 text-[12px]"
                />
              </div>
            </div>
            {periodError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {periodError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10.5px] text-ink-400">Reopening requires a note and admin review.</p>
              <Button
                type="submit"
                disabled={busy === "period"}
                className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
              >
                {busy === "period" ? "Creating…" : "Create checklist"}
              </Button>
            </div>
          </form>

          {loading ? (
            <div className="space-y-2 p-5">
              {[0, 1].map((index) => (
                <div key={index} className="h-12 animate-pulse rounded-md bg-paper-muted" />
              ))}
            </div>
          ) : periods.length === 0 ? (
            <EmptyState
              icon={CalendarRange}
              title="No close periods yet."
              text="Create a checklist to track unresolved work for a date range."
            />
          ) : (
            <ul className="divide-y divide-border">
              {periods.map((period) => (
                <li key={period.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[12.5px] font-medium text-ink-900">
                        {formatDate(period.period_start)} – {formatDate(period.period_end)}
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-ink-400">end exclusive</p>
                      {period.close_note && (
                        <p className="mt-1 text-[11px] text-ink-500">{period.close_note}</p>
                      )}
                    </div>
                    <StatusBadge status={period.status} />
                  </div>
                  {admin && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        aria-label={`Review note for period ${period.period_start}`}
                        placeholder="Reviewer note"
                        value={notes[period.id] ?? ""}
                        onChange={(event) => setNotes({ ...notes, [period.id]: event.target.value })}
                        className="h-8 flex-1 bg-card text-[11.5px]"
                      />
                      <Button
                        variant={period.status === "closed" ? "outline" : "default"}
                        className={
                          period.status === "closed"
                            ? "h-8 text-[11.5px]"
                            : "h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                        }
                        disabled={busy === period.id}
                        onClick={() =>
                          void changePeriod(period, period.status === "closed" ? "reopen" : "close")
                        }
                      >
                        {busy === period.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : period.status === "closed" ? (
                          <RotateCcw className="size-3.5" />
                        ) : (
                          <FileCheck2 className="size-3.5" />
                        )}
                        {period.status === "closed" ? "Reopen" : "Close period"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader
              title="Finance scenario simulator"
              description="Replayable examples. Simulations never alter the ledger or move money."
            />
            <div className="space-y-3 p-5">
              <div className="space-y-2">
                <Label htmlFor="scenario">Scenario</Label>
                <Select value={scenario} onValueChange={setScenario}>
                  <SelectTrigger id="scenario" className="h-9 w-full bg-card text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scenarios.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10.5px] text-ink-400">Saved to workspace history.</p>
                <Button
                  className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                  disabled={busy === "scenario"}
                  onClick={() => void simulate()}
                >
                  <Play className="size-3.5" />
                  {busy === "scenario" ? "Running…" : "Run simulation"}
                </Button>
              </div>
            </div>
          </Panel>

          {admin && (
            <Panel>
              <PanelHeader
                title="Temporary approval delegation"
                description="Allow an active finance operator to review transfers while you are away."
              />
              <form onSubmit={createDelegation} className="space-y-3 border-b border-border p-5">
                <div className="space-y-2">
                  <Label htmlFor="delegate-email">Finance operator email</Label>
                  <Input
                    id="delegate-email"
                    type="email"
                    value={delegationForm.delegate_email}
                    onChange={(event) =>
                      setDelegationForm({ ...delegationForm, delegate_email: event.target.value })
                    }
                    required
                    className="h-8 text-[11.5px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="delegate-expiry">Expires at</Label>
                  <Input
                    id="delegate-expiry"
                    type="datetime-local"
                    value={delegationForm.expires_at}
                    onChange={(event) =>
                      setDelegationForm({ ...delegationForm, expires_at: event.target.value })
                    }
                    required
                    className="h-8 text-[11.5px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="delegate-note">Reason</Label>
                  <Input
                    id="delegate-note"
                    value={delegationForm.note}
                    onChange={(event) =>
                      setDelegationForm({ ...delegationForm, note: event.target.value })
                    }
                    maxLength={500}
                    required
                    className="h-8 text-[11.5px]"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10.5px] text-ink-400">Self-approval remains blocked.</p>
                  <Button
                    type="submit"
                    disabled={busy === "delegation"}
                    className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                  >
                    {busy === "delegation" ? "Saving…" : "Create delegation"}
                  </Button>
                </div>
              </form>
              <ul className="divide-y divide-border">
                {delegations.length === 0 ? (
                  <li className="px-5 py-4 text-[11.5px] text-ink-400">
                    No active approval delegations.
                  </li>
                ) : (
                  delegations.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] font-medium text-ink-900">
                          {item.delegate_name}
                        </p>
                        <p className="truncate text-[10.5px] text-ink-400">{item.delegate_email}</p>
                        <p className="mt-0.5 text-[10px] text-ink-400">
                          expires {formatDateTime(item.expires_at)}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10.5px]"
                        disabled={busy === item.id}
                        onClick={() => void revokeDelegation(item)}
                      >
                        <Trash2 className="size-3" />
                        Revoke
                      </Button>
                    </li>
                  ))
                )}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      <Panel className="mt-4">
        <PanelHeader
          title="Audit trail"
          description={`${filteredAudit.length} loaded decisions · search the latest records`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search audit history"
                placeholder="Search action, actor, or record"
                value={auditQuery}
                onChange={(event) => setAuditQuery(event.target.value)}
                className="h-8 w-[220px] bg-card text-[11.5px]"
              />
              <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={exportAudit}>
                <Download className="size-3.5" />
                Export CSV
              </Button>
            </div>
          }
        />
        {filteredAudit.length === 0 ? (
          <EmptyState
            icon={FileCheck2}
            title="No audit records"
            text="No records match the search, or the audit log is empty."
          />
        ) : (
          <ul className="divide-y divide-border">
            {filteredAudit.map((entry) => (
              <li key={entry.id} className="px-5 py-3">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[12px] font-medium text-ink-900">
                        {entry.action.replaceAll(".", " ")}
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-ink-400">
                        {entry.resource_type} · {entry.resource_id} · actor{" "}
                        {entry.actor_id ?? "system"}
                      </p>
                    </div>
                    <span className="font-mono text-[10.5px] text-ink-400">
                      {formatDateTime(entry.created_at)}
                    </span>
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-paper p-2.5 font-mono text-[10.5px] text-ink-600">
                    {JSON.stringify(entry.metadata ?? {}, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between border-t border-border px-5 py-2.5">
          <p className="text-[10.5px] text-ink-400">Export includes the filtered loaded page.</p>
          {auditCursor && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10.5px]"
              onClick={() => void loadMoreAudit()}
              disabled={auditLoading}
            >
              {auditLoading ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
