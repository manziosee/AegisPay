"use client";

import { GettingStarted } from "@/components/onboarding/getting-started";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftRight,
  ArrowRight,
  BadgeCheck,
  Banknote,
  FileUp,
  Landmark,
  Plus,
  ShieldAlert
} from "lucide-react";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { useTransferDecision } from "@/hooks/use-transfer-decision";
import {
  firstName,
  formatDate,
  formatMinor,
  greeting,
  statusLabel
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FraudCase, ReconciliationImport, Transfer } from "@/lib/types";

type QueueKey = "approvals" | "reconciliation" | "risk";

const queueLabels: Record<QueueKey, string> = {
  approvals: "Approvals",
  reconciliation: "Reconciliation",
  risk: "Risk review"
};

function MetaStrip({
  counts
}: {
  counts: { transactions: number; pendingApprovals: number; exceptionCount: number; openCases: number };
}) {
  const items = [
    { label: "Transactions · 30 days", value: counts.transactions },
    { label: "Awaiting approval", value: counts.pendingApprovals },
    { label: "Reconciliation exceptions", value: counts.exceptionCount },
    { label: "Open risk cases", value: counts.openCases }
  ];
  return (
    <div className="mb-4 grid grid-cols-2 divide-border rounded-xl border border-border bg-card sm:grid-cols-4 sm:divide-x">
      {items.map((item) => (
        <div key={item.label} className="px-4 py-3">
          <p className="text-[11px] text-ink-400">{item.label}</p>
          <p className="mt-1 font-mono text-[20px] font-medium leading-none tracking-[-0.03em] text-ink-950">
            {item.value.toLocaleString("en")}
          </p>
        </div>
      ))}
    </div>
  );
}

function QueueTabs({
  active,
  onSelect,
  counts
}: {
  active: QueueKey;
  onSelect: (value: QueueKey) => void;
  counts: { pendingApprovals: number; exceptionCount: number; openCases: number };
}) {
  const values: Record<QueueKey, number> = {
    approvals: counts.pendingApprovals,
    reconciliation: counts.exceptionCount,
    risk: counts.openCases
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
      {(Object.keys(queueLabels) as QueueKey[]).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={active === key}
          onClick={() => onSelect(key)}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors",
            active === key
              ? "bg-paper-muted font-medium text-ink-950"
              : "text-ink-500 hover:text-ink-900"
          )}
        >
          {queueLabels[key]}
          <span className="font-mono text-[10.5px] text-ink-400">{values[key]}</span>
        </button>
      ))}
    </div>
  );
}

function TransferInspector({
  transfer,
  busy,
  error,
  onDecision
}: {
  transfer: Transfer;
  busy: boolean;
  error: string;
  onDecision: (transfer: Transfer, decision: "approve" | "reject") => void;
}) {
  const received = transfer.approvals_received ?? 0;
  const required = transfer.required_approvals ?? 1;
  return (
    <Panel>
      <PanelHeader
        title="Selected transfer"
        description="Separate-user review"
        action={<StatusBadge status={transfer.status} />}
      />
      <div className="space-y-4 p-5">
        <div>
          <p className="font-mono text-[11px] text-ink-400">{transfer.reference}</p>
          <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.03em] text-ink-950">
            {formatMinor(transfer.amount, transfer.currency)}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-4 border-y border-border py-4">
          <div>
            <dt className="text-[11px] text-ink-400">Requested</dt>
            <dd className="mt-1 text-[12px] text-ink-800">{formatDate(transfer.created_at)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-400">Transfer ID</dt>
            <dd className="mt-1 truncate font-mono text-[11px] text-ink-800">{transfer.id}</dd>
          </div>
        </dl>
        <div>
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="text-ink-500">Approvals received</span>
            <span className="font-mono text-ink-800">
              {received} of {required}
            </span>
          </div>
          <Progress
            value={Math.min(100, (received / Math.max(required, 1)) * 100)}
            className="mt-2 h-1.5 bg-paper-muted"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-coral/20 bg-coral-soft px-3 py-2 text-[11.5px] text-[#a83422]">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            className="h-9 flex-1 bg-primary text-[12.5px] font-semibold text-primary-foreground"
            disabled={busy}
            onClick={() => onDecision(transfer, "approve")}
          >
            {busy ? "Saving…" : "Approve"}
          </Button>
          <Button
            variant="outline"
            className="h-9 flex-1 border-coral/30 text-[12.5px] text-coral hover:bg-coral-soft"
            disabled={busy}
            onClick={() => onDecision(transfer, "reject")}
          >
            Reject
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export default function OverviewPage() {
  const { fullName } = useSession();
  const { data, counts, loading } = useWorkspaceData();
  const [queue, setQueue] = useState<QueueKey>("approvals");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { decide, busyId, error, rejectDialog } = useTransferDecision();

  const pendingTransfers = data.transfers.filter((item) => item.status === "pending_approval");
  const openCases = data.fraudCases.filter((item) => item.status !== "resolved");
  const exceptionImports = data.imports.filter((item) => item.exception_count > 0);
  const recent = useMemo(
    () =>
      [...data.transactions]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 6),
    [data.transactions]
  );

  const currencyRows = useMemo(() => {
    const map = new Map<string, { currency: string; count: number; amount: number; types: Set<string> }>();
    for (const item of data.transactionSummary) {
      const key = item.currency.trim().toUpperCase();
      const current = map.get(key) ?? {
        currency: key,
        count: 0,
        amount: 0,
        types: new Set<string>()
      };
      current.count += item.count;
      current.amount += item.amount_minor;
      current.types.add(item.type);
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [data.transactionSummary]);

  const activity = useMemo(() => {
    const days = 14;
    const buckets = Array.from({ length: days }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (days - 1 - index));
      return {
        key: date.toISOString().slice(0, 10),
        date,
        count: 0
      };
    });
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    for (const item of data.transactions) {
      const key = item.created_at.slice(0, 10);
      const bucket = byKey.get(key);
      if (bucket) bucket.count += 1;
    }
    return buckets;
  }, [data.transactions]);

  const maxActivity = Math.max(1, ...activity.map((item) => item.count));
  const allZero =
    counts.transactions === 0 &&
    counts.pendingApprovals === 0 &&
    counts.exceptionCount === 0 &&
    counts.openCases === 0;

  const selectedTransfer = pendingTransfers.find((item) => item.id === selectedId);
  const selectedImport = exceptionImports.find((item) => item.id === selectedId);
  const selectedCase = openCases.find((item) => item.id === selectedId);

  const header = (
    <PageHeader
      title={`${greeting()}, ${firstName(fullName)}.`}
      description="Work waiting for a decision, then the last 30 days of ledger activity in this workspace."
      actions={
        <>
          <Button asChild variant="outline" className="h-9 border-border bg-card text-[12.5px]">
            <Link href="/app/money">
              <Plus className="size-3.5" />
              New payment request
            </Link>
          </Button>
          <Button asChild className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground">
            <Link href="/app/intelligence">
              <ShieldAlert className="size-3.5" />
              Evaluate transaction
            </Link>
          </Button>
        </>
      }
    />
  );

  if (allZero && !loading) {
    return (
      <div>
        {header}
        <GettingStarted />
        <OnboardingPanel />
      </div>
    );
  }

  return (
    <div>
      {header}
      {rejectDialog}
      <GettingStarted />

      <MetaStrip counts={counts} />

      <QueueTabs active={queue} onSelect={setQueue} counts={counts} />

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Panel className="min-h-[330px]">
          <PanelHeader
            title={queueLabels[queue]}
            description={
              queue === "approvals"
                ? "Transfers waiting for a separate reviewer"
                : queue === "reconciliation"
                  ? "Imports with statement exceptions"
                  : "Cases waiting for an analyst decision"
            }
            action={
              <Button asChild variant="ghost" size="sm" className="h-7 text-[11.5px] text-ink-500">
                <Link href={`/app/${queue === "risk" ? "intelligence" : queue}`}>
                  Open queue <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            }
          />

          {queue === "approvals" &&
            (pendingTransfers.length === 0 ? (
              <EmptyState
                icon={BadgeCheck}
                title="Approval queue is clear"
                text="New transfers requiring a second user's approval will appear here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      <th className="px-5 py-2 text-[10.5px] font-medium text-ink-400">Transfer</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Amount</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Requested</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Approvals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingTransfers.map((item) => (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(item.id);
                          }
                        }}
                        aria-selected={selectedId === item.id}
                        className={cn(
                          "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                          selectedId === item.id && "bg-primary-soft/40"
                        )}
                      >
                        <td className="px-5 py-3 font-mono text-[11px] text-ink-800">{item.reference}</td>
                        <td className="px-3 py-3 font-mono text-[11.5px] text-ink-900">
                          {formatMinor(item.amount, item.currency)}
                        </td>
                        <td className="px-3 py-3 text-ink-500">{formatDate(item.created_at)}</td>
                        <td className="px-3 py-3 font-mono text-[11px] text-ink-500">
                          {item.approvals_received ?? 0}/{item.required_approvals ?? 1}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {queue === "reconciliation" &&
            (exceptionImports.length === 0 ? (
              <EmptyState
                icon={Landmark}
                title="No open exceptions"
                text="Statement imports with unmatched or mismatched lines will appear here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      <th className="px-5 py-2 text-[10.5px] font-medium text-ink-400">Import</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Lines</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Exceptions</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exceptionImports.map((item) => (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(item.id);
                          }
                        }}
                        aria-selected={selectedId === item.id}
                        className={cn(
                          "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                          selectedId === item.id && "bg-primary-soft/40"
                        )}
                      >
                        <td className="px-5 py-3 text-ink-900">{item.source_name}</td>
                        <td className="px-3 py-3 font-mono text-[11px]">{item.line_count}</td>
                        <td className="px-3 py-3 font-mono text-[11px] text-amber">{item.exception_count}</td>
                        <td className="px-3 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {queue === "risk" &&
            (openCases.length === 0 ? (
              <EmptyState
                icon={ShieldAlert}
                title="No open cases"
                text="New cases marked for review by the risk service will appear here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      <th className="px-5 py-2 text-[10.5px] font-medium text-ink-400">Reference</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Score</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Level</th>
                      <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openCases.map((item) => (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(item.id);
                          }
                        }}
                        aria-selected={selectedId === item.id}
                        className={cn(
                          "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                          selectedId === item.id && "bg-primary-soft/40"
                        )}
                      >
                        <td className="px-5 py-3 font-mono text-[11px] text-ink-800">
                          {item.transaction_reference}
                        </td>
                        <td className="px-3 py-3 font-mono text-[11px]">{item.risk_score}</td>
                        <td className="px-3 py-3 capitalize text-ink-500">{item.risk_level}</td>
                        <td className="px-3 py-3 text-ink-500">{formatDate(item.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </Panel>

        {queue === "approvals" && selectedTransfer ? (
          <TransferInspector
            transfer={selectedTransfer}
            busy={busyId === selectedTransfer.id}
            error={error}
            onDecision={(transfer, decision) => void decide(transfer, decision)}
          />
        ) : queue === "approvals" ? (
          <Panel>
            <PanelHeader title="Selected record" description="Choose a transfer from the queue" />
            <EmptyState
              icon={BadgeCheck}
              title="No transfer selected"
              text="Select a row to review the approval count and record a decision."
            />
          </Panel>
        ) : queue === "reconciliation" && selectedImport ? (
          <Panel>
            <PanelHeader title="Selected import" action={<StatusBadge status={selectedImport.status} />} />
            <div className="space-y-4 p-5">
              <div>
                <p className="text-[11px] text-ink-400">Source</p>
                <p className="mt-1 text-[14px] font-medium text-ink-900">{selectedImport.source_name}</p>
                <p className="mt-0.5 font-mono text-[10.5px] text-ink-400">{selectedImport.id}</p>
              </div>
              <dl className="grid grid-cols-3 gap-3 border-y border-border py-4">
                {[
                  ["Lines", selectedImport.line_count],
                  ["Matched", selectedImport.matched_count],
                  ["Exceptions", selectedImport.exception_count]
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10.5px] text-ink-400">{label}</dt>
                    <dd className="mt-1 font-mono text-[15px] text-ink-900">{value}</dd>
                  </div>
                ))}
              </dl>
              <Button asChild className="h-9 w-full bg-primary text-[12.5px] font-semibold text-primary-foreground">
                <Link href="/app/reconciliation">Open reconciliation</Link>
              </Button>
            </div>
          </Panel>
        ) : queue === "reconciliation" ? (
          <Panel>
            <PanelHeader title="Selected record" description="Choose an import from the queue" />
            <EmptyState
              icon={Landmark}
              title="No import selected"
              text="Select an import to inspect its matched and exception counts."
            />
          </Panel>
        ) : queue === "risk" && selectedCase ? (
          <Panel>
            <PanelHeader title="Selected case" action={<StatusBadge status={selectedCase.priority} />} />
            <div className="space-y-4 p-5">
              <div>
                <p className="text-[11px] text-ink-400">Transaction reference</p>
                <p className="mt-1 font-mono text-[13px] text-ink-900">
                  {selectedCase.transaction_reference}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-paper p-3">
                <div className="flex items-end justify-between">
                  <span className="text-[11px] text-ink-400">Risk score</span>
                  <span className="font-mono text-[24px] leading-none text-ink-950">
                    {selectedCase.risk_score}
                  </span>
                </div>
                <Progress value={selectedCase.risk_score} className="mt-2 h-1.5 bg-paper-muted" />
                <p className="mt-2 text-[11px] capitalize text-ink-500">
                  {selectedCase.risk_level} risk · opened {formatDate(selectedCase.created_at)}
                </p>
              </div>
              <Button asChild className="h-9 w-full bg-primary text-[12.5px] font-semibold text-primary-foreground">
                <Link href="/app/intelligence">Open risk review</Link>
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel>
            <PanelHeader title="Selected record" description="Choose a case from the queue" />
            <EmptyState
              icon={ShieldAlert}
              title="No case selected"
              text="Select a case to see its reference, risk score and level."
            />
          </Panel>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <Panel>
          <PanelHeader
            title="Recent transactions"
            description="Latest activity recorded in the internal ledger"
            action={
              <Button asChild variant="ghost" size="sm" className="h-7 text-[11.5px] text-ink-500">
                <Link href="/app/transactions">
                  View all <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transactions yet"
              text="When your team records activity, it will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-paper-muted/60">
                    <th className="px-5 py-2 text-[10.5px] font-medium text-ink-400">Transaction</th>
                    <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Type</th>
                    <th className="px-3 py-2 text-right text-[10.5px] font-medium text-ink-400">Amount</th>
                    <th className="px-3 py-2 text-[10.5px] font-medium text-ink-400">Status</th>
                    <th className="px-5 py-2 text-[10.5px] font-medium text-ink-400">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((item) => (
                    <tr key={`${item.type}-${item.id}`} className="border-b border-border/70 last:border-0">
                      <td className="px-5 py-3">
                        <p className="font-mono text-[11px] text-ink-800">{item.reference}</p>
                        <p className="mt-0.5 max-w-[160px] truncate font-mono text-[9.5px] text-ink-300">
                          {item.id}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-[11.5px] capitalize text-ink-500">{item.type}</td>
                      <td className="px-3 py-3 text-right font-mono text-[11.5px] text-ink-900">
                        {formatMinor(item.amount_minor, item.currency)}
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="px-5 py-3 text-[11px] text-ink-400">{formatDate(item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Currency position" description="Loaded 30-day report by currency" />
          {currencyRows.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No currency activity"
              text="Currency totals appear once transactions are recorded."
            />
          ) : (
            <div className="divide-y divide-border">
              {currencyRows.map((row) => (
                <div key={row.currency} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="font-mono text-[12px] text-ink-900">{row.currency}</p>
                    <p className="mt-0.5 text-[10.5px] capitalize text-ink-400">
                      {[...row.types].join(", ")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[12px] text-ink-900">
                      {formatMinor(row.amount, row.currency)}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-ink-400">{row.count} records</p>
                  </div>
                </div>
              ))}
              <p className="px-5 py-3 text-[10.5px] leading-relaxed text-ink-400">
                Transaction totals, not account balances. No currency conversion is applied.
              </p>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHeader
          title="Record activity"
          description="Ledger records per day across all currencies · last 14 days"
        />
        <div className="px-5 py-5">
          <div className="flex h-28 items-end gap-1.5" role="img" aria-label="Daily record counts">
            {activity.map((item) => (
              <div key={item.key} className="group flex flex-1 flex-col items-center gap-1.5">
                <div
                  className="w-full rounded-t-sm bg-primary/20 transition-colors group-hover:bg-primary/40"
                  style={{ height: `${Math.max(4, (item.count / maxActivity) * 92)}px` }}
                  title={`${formatDate(item.date)}: ${item.count} records`}
                />
                <span className="hidden text-[9px] text-ink-300 sm:block">
                  {item.date.getDate()}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[10.5px] text-ink-400">
            <span>{formatDate(activity[0]?.date ?? new Date())}</span>
            <span>
              {data.transactions.length} record{data.transactions.length === 1 ? "" : "s"} loaded
            </span>
            <span>{formatDate(activity[activity.length - 1]?.date ?? new Date())}</span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function OnboardingPanel() {
  const actions = [
    {
      icon: Banknote,
      title: "Create a payment request",
      text: "Record a receivable reference and share your own bank instructions.",
      href: "/app/money"
    },
    {
      icon: FileUp,
      title: "Import a bank statement",
      text: "Match statement references against ledger records and resolve exceptions.",
      href: "/app/money#statement"
    },
    {
      icon: ShieldAlert,
      title: "Evaluate a transaction",
      text: "Score a reference and store the risk decision before review.",
      href: "/app/intelligence"
    }
  ];

  return (
    <Panel>
      <PanelHeader
        title="Start with a real record"
        description="This workspace has no financial records in the last 30 days. Choose the first operation."
      />
      <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        {actions.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.title}
              href={item.href}
              className="group flex flex-col gap-3 p-5 transition-colors hover:bg-paper-muted/50"
            >
              <span className="grid size-9 place-items-center rounded-lg border border-border bg-paper text-ink-500">
                <Icon className="size-4" />
              </span>
              <span>
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-900">
                  {item.title}
                  <ArrowRight className="size-3.5 text-ink-300 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-400">
                  {item.text}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
      <p className="border-t border-border bg-paper-muted/60 px-5 py-3 text-[10.5px] text-ink-400">
        Approvals, exceptions and risk cases appear here as soon as records exist.
      </p>
    </Panel>
  );
}
