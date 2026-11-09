"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { currencyFractionDigits, formatMinor } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
 * Small SVG charts for the workspace. Colors are validated for color-vision
 * deficiency and contrast on the white card surface: violet carries money in
 * and the main series, orange carries money out and the second series. Text
 * never takes a series color; tooltips work on hover and keyboard focus, and
 * every chart has a table view.
 */
export const SERIES = { primary: "#5a4bff", secondary: "#eb6834" };
const GRID = "#ebe8e1";
const AXIS_TEXT = "#6b778c";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(node);
    setWidth(Math.floor(node.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Compact axis label in major units: 1.2K, 3.4M. */
export function compactMinor(amountMinor: number, currency: string) {
  const major = amountMinor / 10 ** currencyFractionDigits(currency);
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(major);
}

/** Round tick values covering [min, max] in minor units. */
function niceTicks(min: number, max: number, count = 4) {
  if (min === max) {
    max = min + 1;
  }
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) ?? magnitude * 10;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  // The last tick must reach the largest value, so no mark rises past the grid.
  for (let v = start; ; v += step) {
    ticks.push(Math.round(v));
    if (v >= max || ticks.length > 20) break;
  }
  return ticks;
}

function shortDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: React.ReactNode }) {
  const left = Math.min(Math.max(x - 90, 0), Math.max(width - 180, 0));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-[180px] rounded-md border border-border bg-card px-3 py-2 text-[11px] shadow-lift"
      style={{ left, top: Math.max(y - 8, 0), transform: "translateY(-100%)" }}
    >
      {children}
    </div>
  );
}

function TooltipRow({ color, label, value, dashed }: { color: string; label: string; value: string; dashed?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-ink-500">
        <svg width="12" height="4" aria-hidden>
          <line x1="0" y1="2" x2="12" y2="2" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} />
        </svg>
        {label}
      </span>
      <span className="font-mono font-semibold text-ink-950">{value}</span>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; shape?: "rect" | "line" | "dashed" }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          {item.shape === "rect" || !item.shape ? (
            <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ background: item.color }} />
          ) : (
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke={item.color} strokeWidth="2" strokeDasharray={item.shape === "dashed" ? "4 3" : undefined} />
            </svg>
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** A disclosure with the chart's numbers as a table. */
export function ChartTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: string[][] }) {
  return (
    <details className="mt-2 text-[11px]">
      <summary className="cursor-pointer text-ink-400 hover:text-ink-700">Show as table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-paper-muted">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-3 py-1.5 font-medium text-ink-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border/70">
                {row.map((cell, j) => (
                  <td key={j} className={cn("px-3 py-1.5 text-ink-700", j > 0 && "font-mono tabular-nums")}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const PAD = { top: 12, right: 8, bottom: 22, left: 44 };

/**
 * Money in (up) and money out (down) per day, from one shared zero line, so
 * both read on one scale without stacking.
 */
export function FlowChart({
  series,
  currency,
  height = 220
}: {
  series: { date: string; money_in: number; money_out: number }[];
  currency: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const maxIn = Math.max(0, ...series.map((d) => d.money_in));
  const maxOut = Math.max(0, ...series.map((d) => d.money_out));
  const ticks = useMemo(() => niceTicks(-maxOut, Math.max(maxIn, 1), 4), [maxIn, maxOut]);
  const lo = Math.min(ticks[0], 0);
  const hi = Math.max(ticks[ticks.length - 1], 1);
  const plotW = Math.max(width - PAD.left - PAD.right, 0);
  const plotH = height - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;
  const slot = series.length ? plotW / series.length : 0;
  const barW = Math.max(Math.min(24, slot - 2), 1);
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(plotW / 56))));
  const zero = y(0);
  const r = Math.min(4, barW / 2);

  // A column with a 4px rounded data end and a square end at the baseline.
  const column = (x: number, value: number, up: boolean) => {
    const top = up ? y(value) : zero;
    const bottom = up ? zero : y(-value);
    const h = bottom - top;
    if (h <= 0) return "";
    const rr = Math.min(r, h);
    if (up) {
      return `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + barW - rr} Q${x + barW},${top} ${x + barW},${top + rr} V${bottom} Z`;
    }
    return `M${x},${top} V${bottom - rr} Q${x},${bottom} ${x + rr},${bottom} H${x + barW - rr} Q${x + barW},${bottom} ${x + barW},${bottom - rr} V${top} Z`;
  };

  const point = active !== null ? series[active] : null;
  return (
    <div>
      <div ref={ref} className="relative" onMouseLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`Money in and out per day in ${currency}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#c9c4b8" : GRID} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill={AXIS_TEXT} className="tabular-nums">
                  {compactMinor(Math.abs(t), currency)}
                </text>
              </g>
            ))}
            {series.map((d, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2;
              const dim = active !== null && active !== i;
              return (
                <g
                  key={d.date}
                  tabIndex={0}
                  role="button"
                  aria-label={`${shortDate(d.date)}: in ${formatMinor(d.money_in, currency)}, out ${formatMinor(d.money_out, currency)}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none"
                >
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                  <path d={column(x, d.money_in, true)} fill={SERIES.primary} opacity={dim ? 0.45 : 1} />
                  <path d={column(x, d.money_out, false)} fill={SERIES.secondary} opacity={dim ? 0.45 : 1} />
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={height - 6} textAnchor="middle" fontSize="10" fill={AXIS_TEXT}>
                      {shortDate(d.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {point && active !== null && (
          <Tooltip x={PAD.left + active * slot + slot / 2} y={y(point.money_in)} width={width}>
            <p className="mb-1 text-ink-400">{shortDate(point.date)}</p>
            <TooltipRow color={SERIES.primary} label="Money in" value={formatMinor(point.money_in, currency)} />
            <TooltipRow color={SERIES.secondary} label="Money out" value={formatMinor(point.money_out, currency)} />
          </Tooltip>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <Legend
          items={[
            { label: "Money in", color: SERIES.primary },
            { label: "Money out", color: SERIES.secondary }
          ]}
        />
      </div>
      <ChartTable
        caption={`Money in and out per day in ${currency}`}
        headers={["Day", "Money in", "Money out"]}
        rows={series.map((d) => [shortDate(d.date), formatMinor(d.money_in, currency), formatMinor(d.money_out, currency)])}
      />
    </div>
  );
}

/**
 * Balance history (solid) and two projections (dashed): only money already
 * expected, and the recent trend continuing. The zero line is emphasized,
 * since crossing it is what runway measures.
 */
export function ForecastChart({
  history,
  projection,
  currency,
  height = 260
}: {
  history: { date: string; balance: number }[];
  projection: { date: string; known: number; typical: number }[];
  currency: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  type Row = { date: string; actual?: number; known?: number; typical?: number };
  const rows: Row[] = useMemo(() => {
    const out: Row[] = history.map((h) => ({ date: h.date, actual: h.balance }));
    if (out.length) {
      const last = out[out.length - 1];
      last.known = last.actual;
      last.typical = last.actual;
    }
    return out.concat(projection.map((p) => ({ date: p.date, known: p.known, typical: p.typical })));
  }, [history, projection]);
  const values = rows.flatMap((r) => [r.actual, r.known, r.typical].filter((v): v is number => v !== undefined));
  const ticks = useMemo(() => niceTicks(Math.min(0, ...values), Math.max(1, ...values), 4), [values]);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const plotW = Math.max(width - PAD.left - PAD.right, 0);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (rows.length > 1 ? (i / (rows.length - 1)) * plotW : 0);
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo || 1)) * plotH;
  const path = (key: "actual" | "known" | "typical") =>
    rows
      .map((r, i) => (r[key] === undefined ? null : `${x(i)},${y(r[key] as number)}`))
      .filter(Boolean)
      .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
      .join(" ");
  const todayIndex = history.length - 1;
  const labelIndexes = useMemo(() => {
    const n = Math.max(2, Math.floor(plotW / 70));
    const step = Math.max(1, Math.round((rows.length - 1) / n));
    const out: number[] = [];
    for (let i = 0; i < rows.length; i += step) out.push(i);
    return out;
  }, [rows.length, plotW]);

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setActive(Math.max(0, Math.min(rows.length - 1, Math.round(ratio * (rows.length - 1)))));
  };
  const onKey = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowRight") setActive((a) => Math.min(rows.length - 1, (a ?? todayIndex) + 1));
    if (event.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? todayIndex) - 1));
  };
  const row = active !== null ? rows[active] : null;
  return (
    <div>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Balance history and forecast in ${currency}. Use the arrow keys to read values.`}
            tabIndex={0}
            onKeyDown={onKey}
            onFocus={() => setActive((a) => a ?? todayIndex)}
            onBlur={() => setActive(null)}
            className="outline-none"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#b9b3a6" : GRID} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill={AXIS_TEXT}>
                  {t < 0 ? "−" : ""}
                  {compactMinor(Math.abs(t), currency)}
                </text>
              </g>
            ))}
            {todayIndex >= 0 && (
              <g>
                <line x1={x(todayIndex)} x2={x(todayIndex)} y1={PAD.top} y2={PAD.top + plotH} stroke={GRID} strokeWidth={1} />
                <text x={x(todayIndex) + 4} y={PAD.top + 9} fontSize="10" fill={AXIS_TEXT}>
                  Today
                </text>
              </g>
            )}
            <path d={path("typical")} fill="none" stroke={SERIES.secondary} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d={path("known")} fill="none" stroke={SERIES.primary} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d={path("actual")} fill="none" stroke={SERIES.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            {labelIndexes.map((i) => (
              <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="10" fill={AXIS_TEXT}>
                {shortDate(rows[i].date)}
              </text>
            ))}
            {row && active !== null && (
              <g pointerEvents="none">
                <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke="#9aa3b2" strokeWidth={1} />
                {(["actual", "known", "typical"] as const).map((key) =>
                  row[key] === undefined ? null : (
                    <circle
                      key={key}
                      cx={x(active)}
                      cy={y(row[key] as number)}
                      r={4}
                      fill={key === "typical" ? SERIES.secondary : SERIES.primary}
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  )
                )}
              </g>
            )}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
        )}
        {row && active !== null && (
          <Tooltip x={x(active)} y={y(Math.max(row.actual ?? -Infinity, row.known ?? -Infinity, row.typical ?? -Infinity))} width={width}>
            <p className="mb-1 text-ink-400">
              {shortDate(row.date)}
              {active > todayIndex ? " · forecast" : active === todayIndex ? " · today" : ""}
            </p>
            {row.actual !== undefined && <TooltipRow color={SERIES.primary} label="Balance" value={formatMinor(row.actual, currency)} />}
            {active > todayIndex && row.known !== undefined && (
              <TooltipRow color={SERIES.primary} dashed label="Known money only" value={formatMinor(row.known, currency)} />
            )}
            {active > todayIndex && row.typical !== undefined && (
              <TooltipRow color={SERIES.secondary} dashed label="If recent trend continues" value={formatMinor(row.typical, currency)} />
            )}
          </Tooltip>
        )}
      </div>
      <div className="mt-1">
        <Legend
          items={[
            { label: "Balance", color: SERIES.primary, shape: "line" },
            { label: "Known money only", color: SERIES.primary, shape: "dashed" },
            { label: "If recent trend continues", color: SERIES.secondary, shape: "dashed" }
          ]}
        />
      </div>
      <ChartTable
        caption={`Balance history and forecast in ${currency}`}
        headers={["Day", "Balance", "Known money only", "If trend continues"]}
        rows={rows
          .filter((_, i) => i === todayIndex || i % 7 === 0 || i === rows.length - 1)
          .map((r) => [
            shortDate(r.date),
            r.actual !== undefined ? formatMinor(r.actual, currency) : "—",
            r.known !== undefined && r.actual === undefined ? formatMinor(r.known, currency) : "—",
            r.typical !== undefined && r.actual === undefined ? formatMinor(r.typical, currency) : "—"
          ])}
      />
    </div>
  );
}

/** Horizontal bars, one series, value at the tip. */
export function BarList({
  items,
  format
}: {
  items: { label: string; value: number; detail?: string }[];
  format: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="group" title={item.detail}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[11.5px]">
            <span className="text-ink-700 first-letter:uppercase">{item.label}</span>
            <span className="font-mono text-ink-950 tabular-nums">{format(item.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-paper-muted">
            <div
              className="h-2 rounded-full transition-[width]"
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: SERIES.primary }}
            />
          </div>
          {item.detail && <p className="mt-0.5 text-[10.5px] text-ink-400">{item.detail}</p>}
        </li>
      ))}
    </ul>
  );
}
