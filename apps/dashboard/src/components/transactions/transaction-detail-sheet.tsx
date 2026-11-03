"use client";

import Link from "next/link";
import { ArrowUpRight, Gauge, ShieldAlert } from "lucide-react";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { formatDateTime, formatMinor, statusLabel } from "@/lib/format";
import { buildTransactionTimeline } from "@/lib/timeline";
import type { FraudCase, Transaction } from "@/lib/types";

export function TransactionDetailSheet({
  transaction,
  fraudCases,
  onClose
}: {
  transaction: Transaction | null;
  fraudCases: FraudCase[];
  onClose: () => void;
}) {
  const riskCase = transaction
    ? fraudCases.find((item) => item.transaction_reference === transaction.reference)
    : undefined;
  const timeline = transaction ? buildTransactionTimeline(transaction, fraudCases) : [];

  return (
    <Sheet open={Boolean(transaction)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[560px]"
      >
        {transaction && (
          <>
            <SheetHeader className="border-b border-border bg-card px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="rounded border border-border bg-paper-muted px-1.5 py-0.5 text-[10px] capitalize text-ink-500">
                  {transaction.type}
                </span>
                <StatusBadge status={transaction.status} />
              </div>
              <SheetTitle className="mt-2 font-mono text-[15px] tracking-normal text-ink-950">
                {transaction.reference}
              </SheetTitle>
              <SheetDescription className="flex items-center justify-between gap-3 font-mono text-[10.5px] text-ink-400">
                <span className="truncate">{transaction.id}</span>
                <span>{formatDateTime(transaction.created_at)}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="border-b border-border bg-card px-5 pb-4">
              <p className="text-[11px] text-ink-400">Amount</p>
              <p className="mt-1 text-[30px] font-semibold leading-none tracking-[-0.035em] text-ink-950">
                {formatMinor(transaction.amount_minor, transaction.currency)}
              </p>
            </div>

            <Tabs defaultValue="timeline" className="px-5 py-4">
              <TabsList className="h-8 w-full justify-start gap-1 bg-paper-muted p-1">
                <TabsTrigger value="timeline" className="h-6 flex-1 text-[11.5px]">
                  Timeline
                </TabsTrigger>
                <TabsTrigger value="risk" className="h-6 flex-1 text-[11.5px]">
                  Risk
                </TabsTrigger>
                <TabsTrigger value="related" className="h-6 flex-1 text-[11.5px]">
                  Related
                </TabsTrigger>
              </TabsList>

              <TabsContent value="timeline" className="mt-4">
                <ol className="relative border-l border-border pl-4">
                  {timeline.map((event) => (
                    <li key={event.id} className="relative pb-5 last:pb-0">
                      <span className="absolute -left-[21px] top-1 size-2 rounded-full bg-mint ring-2 ring-paper" />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[12.5px] font-medium text-ink-900">{event.label}</p>
                        <StatusBadge status={event.state} />
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">{event.detail}</p>
                      <p className="mt-1 font-mono text-[10px] text-ink-400">
                        {event.source} · {formatDateTime(event.timestamp)}
                      </p>
                    </li>
                  ))}
                </ol>
                <p className="mt-4 border-t border-border pt-3 text-[10.5px] leading-relaxed text-ink-400">
                  Only events supported by loaded records are shown. A missing stage means the
                  record was not loaded, not that it did not happen.
                </p>
              </TabsContent>

              <TabsContent value="risk" className="mt-4">
                {riskCase ? (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-ink-400">Risk score</span>
                      <StatusBadge status={riskCase.priority} />
                    </div>
                    <p className="mt-2 font-mono text-[32px] leading-none text-ink-950">
                      {riskCase.risk_score}
                    </p>
                    <p className="mt-1 text-[11.5px] capitalize text-ink-500">
                      {riskCase.risk_level} risk · {statusLabel(riskCase.status)}
                    </p>
                    <Button asChild variant="outline" className="mt-4 h-8 w-full text-[11.5px]">
                      <Link href="/app/intelligence">
                        Open risk review <ArrowUpRight className="size-3.5" />
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <EmptyState
                    icon={ShieldAlert}
                    title="No risk record loaded"
                    text="This reference has no loaded fraud case. Evaluate it to create an assessment."
                    action={
                      <Button asChild className="h-8 bg-primary text-[11.5px] text-primary-foreground">
                        <Link
                          href={`/app/intelligence?reference=${encodeURIComponent(
                            transaction.reference
                          )}&amount=${transaction.amount_minor}&currency=${encodeURIComponent(
                            transaction.currency
                          )}`}
                        >
                          <Gauge className="size-3.5" />
                          Evaluate reference
                        </Link>
                      </Button>
                    }
                  />
                )}
              </TabsContent>

              <TabsContent value="related" className="mt-4 space-y-2">
                <Link
                  href="/app/reconciliation"
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] text-ink-700 hover:bg-paper-muted"
                >
                  Reconciliation imports
                  <ArrowUpRight className="size-3.5 text-ink-400" />
                </Link>
                <Link
                  href="/app/approvals"
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] text-ink-700 hover:bg-paper-muted"
                >
                  Transfer approvals
                  <ArrowUpRight className="size-3.5 text-ink-400" />
                </Link>
                <Link
                  href="/app/accounts"
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] text-ink-700 hover:bg-paper-muted"
                >
                  Ledger entries by account
                  <ArrowUpRight className="size-3.5 text-ink-400" />
                </Link>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
