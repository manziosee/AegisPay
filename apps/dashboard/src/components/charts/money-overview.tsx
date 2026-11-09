"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, BarChart3 } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Button } from "@/components/ui/button";
import { BarList, FlowChart } from "@/components/charts/charts";
import { api, errorMessage } from "@/lib/api";
import { formatMinor, statusLabel } from "@/lib/format";
import type { ActivityReport, CashForecast } from "@/lib/types";
import { cn } from "@/lib/utils";

const RANGES = [7, 30, 90] as const;

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] text-ink-400">{label}</p>
      <p className="mt-1 truncate text-[19px] font-semibold text-ink-950">{value}</p>
      {detail && <p className="mt-0.5 text-[10.5px] text-ink-400">{detail}</p>}
    </div>
  );
}

/** Overview charts: money in and out, payment requests by status, balances and runway. */
export function MoneyOverview() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [currency, setCurrency] = useState("");
  const [report, setReport] = useState<ActivityReport | null>(null);
  const [forecast, setForecast] = useState<CashForecast | null>(null);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (currency) params.set("currency", currency);
      const [activity, cash] = await Promise.all([
        api<ActivityReport>(`/reports/activity?${params}`),
        api<CashForecast>(`/reports/forecast?days=90${currency ? `&currency=${currency}` : ""}`)
      ]);
      setReport(activity);
      setForecast(cash);
    } catch (loadError) {
      if ((loadError as { status?: number }).status === 403) setForbidden(true);
      else setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [days, currency]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) return null;
  const cur = report?.currency ?? currency;
  const net = report ? report.total_in - report.total_out : 0;
  const statuses = report?.collections_by_status ?? [];

  return (
    <section aria-label="Money overview" className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Date range" className="flex rounded-md border border-border bg-card p-0.5">
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={days === value}
              onClick={() => setDays(value)}
              className={cn("rounded px-2.5 py-1 text-[11px] text-ink-500", days === value && "bg-paper-muted font-medium text-ink-900")}
            >
              Last {value} days
            </button>
          ))}
        </div>
        {report && report.balances.length > 1 && (
          <select
            aria-label="Currency"
            value={cur}
            onChange={(event) => setCurrency(event.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 font-mono text-[11.5px]"
          >
            {report.balances.map((b) => (
              <option key={b.currency} value={b.currency}>
                {b.currency}
              </option>
            ))}
          </select>
        )}
      </div>

      {error ? (
        <Panel>
          <EmptyState
            icon={BarChart3}
            title="Charts could not be loaded"
            text={error}
            action={
              <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className={cn("transition-opacity", loading && report && "opacity-60")}>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={`Money in · ${days} days`} value={report ? formatMinor(report.total_in, cur) : "…"} />
            <Stat label={`Money out · ${days} days`} value={report ? formatMinor(report.total_out, cur) : "…"} />
            <Stat
              label="Net change"
              value={report ? `${net > 0 ? "+" : ""}${formatMinor(net, cur)}` : "…"}
              detail={net >= 0 ? "More came in than went out" : "More went out than came in"}
            />
            <Link href="/app/forecast" className="group rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40">
              <p className="flex items-center justify-between text-[11px] text-ink-400">
                Cash runway
                <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </p>
              <p className="mt-1 truncate text-[19px] font-semibold text-ink-950">
                {!forecast ? "…" : forecast.runway_days === null ? "Beyond 90 days" : `${forecast.runway_days} days`}
              </p>
              <p className="mt-0.5 text-[10.5px] text-ink-400">
                {forecast ? `Spending about ${formatMinor(forecast.average_daily_out, forecast.currency)} a day` : " "}
              </p>
            </Link>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Panel>
              <PanelHeader title={`Money in and out, ${cur}`} description="Per day. Moves between your own accounts are left out." />
              <div className="px-5 pb-4 pt-3">
                {report && report.total_in === 0 && report.total_out === 0 ? (
                  <EmptyState icon={BarChart3} title="No money moved in this period" text="Confirmed payments and payouts will appear here." />
                ) : report ? (
                  <FlowChart series={report.series} currency={cur} />
                ) : (
                  <div className="h-[220px]" />
                )}
              </div>
            </Panel>
            <div className="grid gap-4">
              <Panel>
                <PanelHeader title="Payment requests" description={`Requested in the last ${days} days, by status`} />
                <div className="px-5 pb-4 pt-3">
                  {statuses.length === 0 ? (
                    <p className="text-[11.5px] text-ink-400">No payment requests in {cur} in this period.</p>
                  ) : (
                    <BarList
                      items={statuses.map((s) => ({
                        label: statusLabel(s.status),
                        value: s.amount_minor,
                        detail: `${s.count} ${s.count === 1 ? "request" : "requests"}`
                      }))}
                      format={(value) => formatMinor(value, cur)}
                    />
                  )}
                </div>
              </Panel>
              <Panel>
                <PanelHeader
                  title="Balances"
                  description="Money held, per currency"
                  action={
                    <Button asChild variant="ghost" size="sm" className="h-7 text-[11.5px] text-ink-500">
                      <Link href="/app/accounts">
                        Accounts <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  }
                />
                <ul className="divide-y divide-border">
                  {(report?.balances ?? []).length === 0 ? (
                    <li className="px-5 py-3 text-[11.5px] text-ink-400">No balances yet.</li>
                  ) : (
                    report?.balances.map((b) => (
                      <li key={b.currency} className="flex items-center justify-between px-5 py-2.5">
                        <span className="font-mono text-[11.5px] text-ink-500">{b.currency}</span>
                        <span className="font-mono text-[12.5px] text-ink-950 tabular-nums">{formatMinor(b.balance_minor, b.currency)}</span>
                      </li>
                    ))
                  )}
                </ul>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
