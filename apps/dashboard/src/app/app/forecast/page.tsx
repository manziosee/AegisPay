"use client";

import { useCallback, useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Button } from "@/components/ui/button";
import { ForecastChart } from "@/components/charts/charts";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMinor } from "@/lib/format";
import type { CashForecast } from "@/lib/types";
import { cn } from "@/lib/utils";

const HORIZONS = [30, 90, 180] as const;
const kindLabel = { payment_request: "Payment request", collection: "Collection", payout: "Payout", commitment: "Budget commitment" };

export default function ForecastPage() {
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(90);
  const [currency, setCurrency] = useState("");
  const [data, setData] = useState<CashForecast | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ days: String(horizon) });
      if (currency) params.set("currency", currency);
      setData(await api<CashForecast>(`/reports/forecast?${params}`));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [horizon, currency]);

  useEffect(() => {
    void load();
  }, [load]);

  const cur = data?.currency ?? currency;
  const runway =
    data === null
      ? "…"
      : data.runway_days === null
        ? `More than ${data.horizon_days} days`
        : data.runway_days <= 1
          ? "Less than a day"
          : `${data.runway_days} days`;

  return (
    <div>
      <PageHeader
        title="Cash forecast"
        description="How long your money lasts, from your ledger and the payments you already expect. A guide for planning, not a promise."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Forecast length" className="flex rounded-md border border-border bg-card p-0.5">
          {HORIZONS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={horizon === value}
              onClick={() => setHorizon(value)}
              className={cn("rounded px-2.5 py-1 text-[11px] text-ink-500", horizon === value && "bg-paper-muted font-medium text-ink-900")}
            >
              Next {value} days
            </button>
          ))}
        </div>
        {data && data.balances.length > 1 && (
          <select
            aria-label="Currency"
            value={cur}
            onChange={(event) => setCurrency(event.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 font-mono text-[11.5px]"
          >
            {data.balances.map((b) => (
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
            icon={LineChart}
            title="The forecast could not be loaded"
            text={error}
            action={
              <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className={cn("transition-opacity", loading && data && "opacity-60")}>
          <div className="mb-4 grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr_1fr]">
            <div className="rounded-lg border border-border bg-card px-5 py-4">
              <p className="text-[11.5px] text-ink-400">Runway in {cur || "your main currency"}</p>
              <p className="mt-1 text-[44px] font-semibold leading-none text-ink-950">{runway}</p>
              <p className="mt-2 text-[11px] text-ink-500">
                {data?.runway_days === null
                  ? "Known money keeps the balance above zero for the whole period."
                  : "Until the balance would fall below zero, counting only money already expected."}
              </p>
            </div>
            <Tile label="Balance now" value={data ? formatMinor(data.balance_minor, cur) : "…"} />
            <Tile
              label="Average day"
              value={data ? `−${formatMinor(data.average_daily_out, cur)}` : "…"}
              detail={data ? `+${formatMinor(data.average_daily_in, cur)} in` : undefined}
            />
            <Tile
              label="Already expected"
              value={data ? `+${formatMinor(data.expected_in, cur)}` : "…"}
              detail={data ? `−${formatMinor(data.expected_out, cur)} in payouts` : undefined}
            />
          </div>

          <Panel>
            <PanelHeader title={`Balance in ${cur}`} description={data?.note ?? ""} />
            <div className="px-5 pb-4 pt-3">
              {data ? (
                <ForecastChart history={data.history} projection={data.projection} currency={cur} />
              ) : (
                <div className="h-[260px]" />
              )}
            </div>
          </Panel>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Panel>
              <PanelHeader title="Money already expected" description="Open payment requests, pending collections and payouts not yet confirmed" />
              {!data || data.expected.length === 0 ? (
                <p className="px-5 py-4 text-[11.5px] text-ink-400">Nothing is expected in {cur} right now.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11.5px]">
                    <thead>
                      <tr className="border-b border-border bg-paper-muted/60">
                        {["Expected", "Kind", "Reference", "Amount"].map((h) => (
                          <th key={h} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5 last:text-right">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.expected.map((item) => (
                        <tr key={item.id} className="border-b border-border/70 last:border-0">
                          <td className="whitespace-nowrap px-5 py-2.5 text-ink-600">
                            {formatDate(item.expected_on)}
                            {item.overdue && <span className="ml-1.5 rounded bg-amber-soft px-1 text-[10px] text-amber">overdue</span>}
                          </td>
                          <td className="px-4 py-2.5 text-ink-600">{kindLabel[item.kind]}</td>
                          <td className="px-4 py-2.5 font-mono text-ink-900">{item.reference}</td>
                          <td className="whitespace-nowrap px-5 py-2.5 text-right font-mono text-ink-950">
                            {item.kind === "payout" || item.kind === "commitment" ? "−" : "+"}
                            {formatMinor(item.amount_minor, cur)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel>
              <PanelHeader title="How this is worked out" />
              <ul className="space-y-2 px-5 pb-5 pt-3 text-[11.5px] leading-relaxed text-ink-600">
                <li>
                  <strong className="font-medium text-ink-900">Balance</strong> is the money held in your accounts, from the ledger.
                </li>
                <li>
                  <strong className="font-medium text-ink-900">Known money only</strong> adds open payment requests on their due date (or
                  two weeks after they were made), pending collections within a week, and payouts two days after they go to the bank; then it
                  takes away your average daily spending.
                </li>
                <li>
                  <strong className="font-medium text-ink-900">If recent trend continues</strong> assumes money keeps arriving and leaving at
                  the average of the last 90 days.
                </li>
                <li>Overdue items are counted as arriving today. Moves between your own accounts are left out.</li>
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <p className="text-[11px] text-ink-400">{label}</p>
      <p className="mt-1 truncate text-[19px] font-semibold text-ink-950">{value}</p>
      {detail && <p className="mt-0.5 text-[10.5px] text-ink-400">{detail}</p>}
    </div>
  );
}
