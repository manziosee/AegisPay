"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Download, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { TransactionDetailSheet } from "@/components/transactions/transaction-detail-sheet";
import { api, apiBlob, downloadBlob, errorMessage } from "@/lib/api";
import { dateRangeDays, formatDate, formatMinor, statusLabel } from "@/lib/format";
import type { Transaction, TransactionReport } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function TransactionsPage() {
  const { session } = useSession();
  const { data, loading } = useWorkspaceData();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [currency, setCurrency] = useState("all");
  const [extraRows, setExtraRows] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) setQuery(q);
  }, []);

  useEffect(() => {
    setHasMore(Boolean(data.transactionCursor));
    setCursor(null);
    setExtraRows([]);
  }, [data.transactionCursor]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...data.transactions, ...extraRows].filter((item) => {
      const key = `${item.type}-${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [data.transactions, extraRows]);

  const statuses = useMemo(
    () => [...new Set(rows.map((item) => item.status))].sort(),
    [rows]
  );
  const currencies = useMemo(
    () => [...new Set(rows.map((item) => item.currency.toUpperCase()))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((item) => {
      if (type !== "all" && item.type !== type) return false;
      if (status !== "all" && item.status !== status) return false;
      if (currency !== "all" && item.currency.toUpperCase() !== currency) return false;
      if (!needle) return true;
      return `${item.reference} ${item.id} ${item.type} ${item.status}`
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, query, type, status, currency]);

  const loadMore = async () => {
    if (!session) return;
    const next = cursor ?? data.transactionCursor;
    if (!next) return;
    setLoadingMore(true);
    try {
      const { from, to } = dateRangeDays(30);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: "100",
        cursor: next
      });
      const report = await api<TransactionReport>(
        `/reports/transactions?${params.toString()}`,
        session.access_token
      );
      setExtraRows((current) => [...current, ...report.data]);
      setCursor(report.next_cursor);
      setHasMore(Boolean(report.next_cursor));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    if (!session) return;
    setExporting(true);
    try {
      const { from, to } = dateRangeDays(30);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: "100",
        format: "csv"
      });
      if (type !== "all") params.set("type", type);
      if (status !== "all") params.set("status", status);
      if (currency !== "all") params.set("currency", currency);
      const blob = await apiBlob(`/reports/transactions?${params.toString()}`, session.access_token);
      downloadBlob(blob, "aegispay-transactions.csv");
      toast.success("CSV exported for the filtered report page.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Transactions"
        description="Collections, internal transfers and refunds recorded in this ledger. The report covers the last 30 days and pages 100 records at a time."
        actions={
          <Button
            variant="outline"
            className="h-9 border-border bg-card text-[12.5px]"
            onClick={() => void exportCsv()}
            disabled={exporting}
          >
            <Download className="size-3.5" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reference, type, status…"
            className="h-9 bg-card pl-9 text-[12.5px]"
            aria-label="Search transactions"
          />
        </div>
        <FilterSelect label="Type" value={type} onChange={setType} options={["collection", "transfer", "refund"]} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={statuses} />
        <FilterSelect label="Currency" value={currency} onChange={setCurrency} options={currencies} />
        <span className="ml-auto text-[11.5px] text-ink-400">
          {filtered.length} records · last 30 days
        </span>
      </div>

      <Panel>
        <PanelHeader
          title="Transaction record"
          description={`${filtered.length} of ${rows.length} loaded records shown`}
          action={
            hasMore ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : undefined
          }
        />
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-paper-muted" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No matching transactions"
            text="Try a different search or check back after new activity is recorded."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Transaction", "Type", "Created", "Amount", "Status", "Risk"].map((heading) => (
                    <th
                      key={heading}
                      className={cn(
                        "px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5",
                        heading === "Amount" && "text-right"
                      )}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const riskCase = data.fraudCases.find(
                    (item2) => item2.transaction_reference === item.reference
                  );
                  return (
                    <tr
                      key={`${item.type}-${item.id}`}
                      tabIndex={0}
                      onClick={() => setSelected(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(item);
                        }
                      }}
                      className="cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50"
                    >
                      <td className="px-5 py-3">
                        <p className="font-mono text-[11.5px] text-ink-800">{item.reference}</p>
                        <p className="mt-0.5 max-w-[190px] truncate font-mono text-[9.5px] text-ink-300">
                          {item.id}
                        </p>
                      </td>
                      <td className="px-4 py-3 capitalize text-ink-500">{item.type}</td>
                      <td className="px-4 py-3 text-[11px] text-ink-500">
                        {formatDate(item.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[11.5px] text-ink-900">
                        {formatMinor(item.amount_minor, item.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="px-5 py-3">
                        {riskCase ? (
                          <span className="font-mono text-[11px] text-amber">
                            {riskCase.risk_score} · {statusLabel(riskCase.risk_level)}
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5">
          <span className="text-[10.5px] text-ink-400">
            CSV exports the filtered page; the report may contain more records.
          </span>
          {hasMore && (
            <span className="text-[10.5px] text-ink-400">
              {rows.length} loaded · more available
            </span>
          )}
        </div>
      </Panel>

      <TransactionDetailSheet
        transaction={selected}
        fraudCases={data.fraudCases}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-[150px] bg-card text-[12px]" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option} className="capitalize">
            {statusLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
