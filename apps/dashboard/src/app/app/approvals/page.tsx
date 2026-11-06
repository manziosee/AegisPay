"use client";

import { useEffect, useRef, useState } from "react";
import { BadgeCheck, ShieldCheck } from "lucide-react";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { useTransferDecision } from "@/hooks/use-transfer-decision";
import { formatDateTime, formatMinor } from "@/lib/format";
import type { Transfer } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ApprovalsPage() {
  const { data, loading } = useWorkspaceData();
  const pending = data.transfers.filter((item) => item.status === "pending_approval");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { decide, busyId, error, rejectDialog } = useTransferDecision();

  useEffect(() => {
    if (selectedId && !pending.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [pending, selectedId]);

  const selected = pending.find((item) => item.id === selectedId);

  // On phones the reviewer panel sits below the queue, so bring it into view.
  const reviewerPanel = useRef<HTMLDivElement>(null);
  const selectTransfer = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) {
      window.setTimeout(() => reviewerPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };

  return (
    <div>
      {rejectDialog}
      <PageHeader
        title="Transfer approvals"
        description="Record independent reviewer decisions. A transfer posts only after its configured approval count is met."
      />

      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber/20 bg-amber-soft/60 px-3.5 py-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber" />
        <p className="text-[11.5px] leading-relaxed text-[#7a5210]">
          The API enforces separate-user approval: the initiator cannot approve their own transfer,
          and one reviewer cannot record two decisions. Approving does not move funds externally.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Panel className="min-h-[380px]">
          <PanelHeader
            title="Approval queue"
            description={`${pending.length} transfer${pending.length === 1 ? "" : "s"} pending`}
            action={<StatusBadge status="pending_approval" label="Awaiting review" />}
          />
          {loading && pending.length === 0 ? (
            <div className="space-y-2 p-5">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-12 animate-pulse rounded-md bg-paper-muted" />
              ))}
            </div>
          ) : pending.length === 0 ? (
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
                    {["Transfer", "Amount", "Requested", "Approvals", "Status"].map((heading) => (
                      <th
                        key={heading}
                        className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pending.map((item) => (
                    <tr
                      key={item.id}
                      tabIndex={0}
                      onClick={() => selectTransfer(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectTransfer(item.id);
                        }
                      }}
                      aria-selected={selectedId === item.id}
                      className={cn(
                        "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                        selectedId === item.id && "bg-primary-soft/40"
                      )}
                    >
                      <td className="px-5 py-3">
                        <p className="font-mono text-[11.5px] text-ink-800">{item.reference}</p>
                        <p className="mt-0.5 hidden font-mono text-[9.5px] text-ink-300 sm:block">{item.id}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11.5px] text-ink-900">
                        {formatMinor(item.amount, item.currency)}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-ink-500">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-ink-500">
                        {item.approvals_received ?? 0}/{item.required_approvals ?? 1}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border px-5 py-2.5 text-[10.5px] text-ink-400">
            Queue reflects the loaded transfer page (up to 100 records).
          </p>
        </Panel>

        {selected ? (
          <div ref={reviewerPanel} className="scroll-mt-20">
            <TransferPanel
              transfer={selected}
              busy={busyId === selected.id}
              error={error}
              onDecision={(transfer, decision) => void decide(transfer, decision)}
            />
          </div>
        ) : (
          <Panel>
            <PanelHeader title="Reviewer panel" description="Select a transfer to review" />
            <EmptyState
              icon={BadgeCheck}
              title="No transfer selected"
              text="The selected transfer, approval count and permitted decision controls appear here."
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

function TransferPanel({
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
        title="Reviewer panel"
        description="Decision preview"
        action={<StatusBadge status={transfer.status} />}
      />
      <div className="space-y-4 p-5">
        <div>
          <p className="font-mono text-[11px] text-ink-400">{transfer.reference}</p>
          <p className="mt-1 text-[30px] font-semibold leading-none tracking-[-0.035em] text-ink-950">
            {formatMinor(transfer.amount, transfer.currency)}
          </p>
          <p className="mt-1 font-mono text-[10.5px] text-ink-400">{transfer.id}</p>
        </div>

        <dl className="grid grid-cols-2 gap-4 border-y border-border py-4">
          <div>
            <dt className="text-[11px] text-ink-400">Requested</dt>
            <dd className="mt-1 text-[12px] text-ink-800">{formatDateTime(transfer.created_at)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-400">Currency</dt>
            <dd className="mt-1 font-mono text-[12px] text-ink-800">{transfer.currency}</dd>
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
          <p className="mt-2 text-[10.5px] leading-relaxed text-ink-400">
            Ledger posting occurs in the same API transaction that records the final required
            approval.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-coral/20 bg-coral-soft px-3 py-2 text-[11.5px] leading-relaxed text-[#a83422]"
          >
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
