"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  FileCheck2,
  Landmark,
  Maximize2,
  ReceiptText,
  Search,
  ShieldAlert,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { Panel } from "@/components/ui-blocks/panel";
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
import { formatDate, formatMinor } from "@/lib/format";
import type { FraudCase, Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

type GraphNodeKind = "case" | "reference" | "transaction" | "currency";

type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  x: number;
  y: number;
  caseId?: string;
  reference?: string;
  currency?: string;
  amountMinor?: number;
  score?: number;
  status?: string;
  riskLevel?: string;
  priority?: string;
  createdAt?: string;
  matchCount?: number;
  modelVersion?: string;
  transaction?: Transaction;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  tone: "mint" | "amber" | "muted";
};

type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; hiddenCases: number; totalCases: number };

const MAX_CASES = 16;
const COLUMN_X = [108, 366, 624, 894] as const;

const riskColor: Record<string, string> = {
  high: "#d9452f",
  medium: "#b7791f",
  low: "#13b58c"
};

const nodeStroke = (node: GraphNode) => {
  if (node.kind === "case") return riskColor[node.riskLevel ?? "low"] ?? "#b7791f";
  if (node.kind === "reference") return "#5a4bff";
  if (node.kind === "transaction") return "#13b58c";
  return "#5b677f";
};

function layout(nodes: GraphNode[]): GraphNode[] {
  const columns: Record<GraphNodeKind, GraphNode[]> = {
    case: [],
    reference: [],
    transaction: [],
    currency: []
  };
  nodes.forEach((node) => columns[node.kind].push(node));
  const top = 78;
  const available = 448;
  return nodes.map((node) => {
    const column = columns[node.kind];
    const index = column.findIndex((item) => item.id === node.id);
    const x = COLUMN_X[["case", "reference", "transaction", "currency"].indexOf(node.kind)];
    const y =
      column.length <= 1
        ? top + available / 2
        : top + (index + 0.5) * (available / column.length);
    return { ...node, x, y };
  });
}

function truncate(value: string, size: number) {
  if (value.length <= size) return value;
  return `${value.slice(0, size - 1)}…`;
}

export function RelationshipGraph({
  cases,
  transactions,
  onInvestigate
}: {
  cases: FraudCase[];
  transactions: Transaction[];
  onInvestigate?: (caseId: string) => void;
}) {
  const [status, setStatus] = useState("open");
  const [risk, setRisk] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"graph" | "records">("graph");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    width: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const graph = useMemo<Graph>(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = cases
      .filter((item) => (status === "all" ? true : item.status === status))
      .filter((item) => (risk === "all" ? true : item.risk_level === risk))
      .filter((item) => {
        if (!normalized) return true;
        return [item.transaction_reference, item.id, item.currency, item.status, item.risk_level]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const visible = filtered.slice(0, MAX_CASES);
    const transactionByReference = new Map<string, Transaction>();
    transactions.forEach((transaction) => {
      if (!transactionByReference.has(transaction.reference)) {
        transactionByReference.set(transaction.reference, transaction);
      }
    });

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const references = new Map<
      string,
      { count: number; matched: boolean; currency?: string }
    >();
    const currencies = new Set<string>();
    const currencyCounts = new Map<string, number>();
    const matchedByReference = new Map<string, string>();

    visible.forEach((item) => {
      const caseNodeId = `case:${item.id}`;
      const refId = `ref:${item.transaction_reference}`;
      const match = transactionByReference.get(item.transaction_reference);
      const currency = (item.currency || match?.currency || "").toUpperCase();
      const reference = references.get(item.transaction_reference) ?? {
        count: 0,
        matched: false
      };
      reference.count += 1;
      reference.matched = reference.matched || Boolean(match);
      if (currency) reference.currency = currency;
      references.set(item.transaction_reference, reference);
      if (currency) {
        currencies.add(currency);
        currencyCounts.set(currency, (currencyCounts.get(currency) ?? 0) + 1);
      }

      nodes.set(caseNodeId, {
        id: caseNodeId,
        kind: "case",
        label: item.transaction_reference,
        detail: `score ${item.risk_score} · ${item.status}`,
        x: 0,
        y: 0,
        caseId: item.id,
        reference: item.transaction_reference,
        currency,
        score: item.risk_score,
        status: item.status,
        riskLevel: item.risk_level,
        priority: item.priority,
        createdAt: item.created_at,
        amountMinor: item.amount_minor,
        modelVersion: item.model_version
      });

      edges.push({
        id: `${caseNodeId}->${refId}`,
        from: caseNodeId,
        to: refId,
        label: "transaction reference",
        tone: item.status === "resolved" ? "mint" : "amber"
      });

      if (match) {
        const transactionNodeId = `txn:${match.id}`;
        matchedByReference.set(item.transaction_reference, transactionNodeId);
        nodes.set(transactionNodeId, {
          id: transactionNodeId,
          kind: "transaction",
          label: formatMinor(match.amount_minor, match.currency),
          detail: `${match.type} · ${match.id}`,
          x: 0,
          y: 0,
          currency: match.currency.toUpperCase(),
          amountMinor: match.amount_minor,
          status: match.status,
          createdAt: match.created_at,
          reference: match.reference,
          transaction: match
        });
        edges.push({
          id: `${refId}->${transactionNodeId}`,
          from: refId,
          to: transactionNodeId,
          label: "reference match",
          tone: "mint"
        });
      }
    });

    references.forEach((value, reference) => {
      const refId = `ref:${reference}`;
      nodes.set(refId, {
        id: refId,
        kind: "reference",
        label: reference,
        detail: `${value.count} case${value.count === 1 ? "" : "s"} · ${
          value.matched ? "ledger match" : "0 matches"
        }`,
        x: 0,
        y: 0,
        reference,
        currency: value.currency,
        matchCount: value.count
      });
    });

    currencies.forEach((currency) => {
      const currencyNodeId = `currency:${currency}`;
      const count = currencyCounts.get(currency) ?? 0;
      nodes.set(currencyNodeId, {
        id: currencyNodeId,
        kind: "currency",
        label: currency,
        detail: `${count} case${count === 1 ? "" : "s"}`,
        x: 0,
        y: 0,
        currency
      });
    });

    // A currency is connected from the matched ledger record when one exists,
    // otherwise from the reference itself. No inferred FX or exposure.
    references.forEach((value, reference) => {
      if (!value.currency) return;
      const from = matchedByReference.get(reference) ?? `ref:${reference}`;
      const to = `currency:${value.currency}`;
      edges.push({
        id: `${from}->${to}`,
        from,
        to,
        label: "currency",
        tone: "muted"
      });
    });

    return {
      nodes: layout(Array.from(nodes.values())),
      edges,
      hiddenCases: filtered.length - visible.length,
      totalCases: filtered.length
    };
  }, [cases, query, risk, status, transactions]);

  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const neighbors = useMemo(() => {
    if (!selected) return new Set<string>();
    const ids = new Set<string>([selected.id]);
    graph.edges.forEach((edge) => {
      if (edge.from === selected.id) ids.add(edge.to);
      if (edge.to === selected.id) ids.add(edge.from);
    });
    return ids;
  }, [graph.edges, selected]);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes]
  );

  const resetViewport = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const beginDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-graph-node]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
      width: rect.width
    });
  };

  const moveDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const scale = 1000 / Math.max(drag.width, 1);
    setPan({
      x: drag.panX + (event.clientX - drag.startX) * scale,
      y: drag.panY + (event.clientY - drag.startY) * scale
    });
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
  };

  const empty = graph.nodes.length === 0;
  const hasAnyCases = cases.length > 0;

  return (
    <Panel>
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink-950">
              Relationship graph
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-400">
              Loaded cases, their stored references and matching ledger records
            </p>
          </div>
          <div className="inline-flex rounded-md border border-border bg-card p-0.5">
            {(["graph", "records"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={cn(
                  "h-7 rounded px-2.5 text-[11px] capitalize transition-colors",
                  viewMode === mode
                    ? "bg-paper-muted font-medium text-ink-900"
                    : "text-ink-500 hover:text-ink-900"
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search reference, case or currency"
              aria-label="Search relationship graph"
              className="h-8 pl-8 text-[11.5px]"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-[116px] text-[11.5px]" aria-label="Case status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open cases</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
          <Select value={risk} onValueChange={setRisk}>
            <SelectTrigger className="h-8 w-[112px] text-[11.5px]" aria-label="Risk level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All risk</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="mt-2 text-[10.5px] text-ink-400">
          {graph.totalCases} matching case{graph.totalCases === 1 ? "" : "s"}
          {graph.hiddenCases > 0 ? ` · ${graph.hiddenCases} not shown` : ""} · scope: loaded
          records
        </p>
      </div>

      {empty ? (
        <EmptyState
          icon={ShieldAlert}
          title={hasAnyCases ? "No cases match these filters" : "No cases to graph"}
          text={
            hasAnyCases
              ? "Change the status or risk filter to see the loaded cases."
              : "Relationships appear after the fraud service opens a review case."
          }
          action={
            hasAnyCases ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11.5px]"
                onClick={() => {
                  setStatus("all");
                  setRisk("all");
                  setQuery("");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : viewMode === "records" ? (
        <RecordsTable
          nodes={graph.nodes}
          onSelect={(node) => setSelectedId(node.id)}
          selectedId={selectedId}
          onInvestigate={onInvestigate}
        />
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 overflow-x-auto border-b border-border lg:border-b-0 lg:border-r">
            <div className="relative min-w-[720px]">
              <svg
                ref={svgRef}
                viewBox="0 0 1000 620"
                className={cn(
                  "h-[520px] w-full touch-none select-none",
                  drag ? "cursor-grabbing" : "cursor-grab"
                )}
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                role="group"
                aria-label="Aegis relationship graph"
              >
                <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
                  {["Review cases", "Transaction references", "Ledger records", "Currencies"].map(
                    (label, index) => (
                      <text
                        key={label}
                        x={COLUMN_X[index]}
                        y={24}
                        textAnchor="middle"
                        className="fill-ink-400 font-mono text-[9px] uppercase"
                        style={{ letterSpacing: "0.1em" }}
                      >
                        {label}
                      </text>
                    )
                  )}
                  {COLUMN_X.map((x) => (
                    <line
                      key={x}
                      x1={x}
                      y1={38}
                      x2={x}
                      y2={596}
                      stroke="#ece9e1"
                      strokeWidth="1"
                    />
                  ))}

                  {graph.edges.map((edge) => {
                    const from = nodeById.get(edge.from);
                    const to = nodeById.get(edge.to);
                    if (!from || !to) return null;
                    const active =
                      Boolean(selected) && (edge.from === selected!.id || edge.to === selected!.id);
                    const dimmed = Boolean(selected) && !active;
                    const midX = (from.x + to.x) / 2;
                    const path = `M ${from.x + 14} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 14} ${to.y}`;
                    const stroke =
                      active
                        ? "#5a4bff"
                        : edge.tone === "amber"
                          ? "#d9a441"
                          : edge.tone === "mint"
                            ? "#8ccfbd"
                            : "#d5d0c4";
                    return (
                      <path
                        key={edge.id}
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={active ? 1.8 : 1.1}
                        strokeDasharray={edge.tone === "muted" ? "3 5" : edge.tone === "amber" ? "4 5" : undefined}
                        opacity={dimmed ? 0.3 : 1}
                      >
                        <title>{edge.label}</title>
                      </path>
                    );
                  })}

                  {graph.nodes.map((node) => {
                    const active = selectedId === node.id;
                    const dimmed = Boolean(selected) && !neighbors.has(node.id);
                    const stroke = nodeStroke(node);
                    const dark = node.kind === "case" && node.riskLevel === "high";
                    const Icon =
                      node.kind === "case"
                        ? ShieldAlert
                        : node.kind === "reference"
                          ? FileCheck2
                          : node.kind === "transaction"
                            ? ReceiptText
                            : Landmark;
                    return (
                      <g
                        key={node.id}
                        data-graph-node
                        transform={`translate(${node.x},${node.y})`}
                        opacity={dimmed ? 0.34 : 1}
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.kind}: ${node.label}, ${node.detail}`}
                        aria-pressed={active}
                        onClick={() => setSelectedId(node.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(node.id);
                          }
                        }}
                        className="cursor-pointer outline-none"
                      >
                        {active && (
                          <circle r="21" fill="none" stroke="#5a4bff" strokeWidth="1.5" />
                        )}
                        <circle
                          r="14"
                          fill={dark ? "#fbe9e5" : "#fffdf8"}
                          stroke={stroke}
                          strokeWidth="1.5"
                        />
                        <g transform="translate(-8,-8)" color={stroke}>
                          <Icon width={16} height={16} strokeWidth={1.8} />
                        </g>
                        <text
                          y="31"
                          textAnchor="middle"
                          className="fill-ink-800 font-mono text-[9.5px]"
                        >
                          {truncate(node.label, 22)}
                        </text>
                        <text
                          y="43"
                          textAnchor="middle"
                          className="fill-ink-400 text-[8.5px]"
                        >
                          {truncate(node.detail, 28)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>

              <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow-panel">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Zoom out"
                  onClick={() => setZoom((value) => Math.max(0.7, Number((value - 0.15).toFixed(2))))}
                >
                  <ZoomOut className="size-3.5" />
                </Button>
                <span className="w-10 text-center font-mono text-[10px] text-ink-500">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Zoom in"
                  onClick={() => setZoom((value) => Math.min(1.8, Number((value + 0.15).toFixed(2))))}
                >
                  <ZoomIn className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Fit graph"
                  onClick={resetViewport}
                >
                  <Maximize2 className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>

          <EvidencePanel node={selected} onInvestigate={onInvestigate} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border px-5 py-2.5">
        {[
          ["#d9452f", "High risk case"],
          ["#b7791f", "Medium risk case"],
          ["#13b58c", "Low risk / ledger"],
          ["#5a4bff", "Transaction reference"],
          ["#d5d0c4", "Currency relation"]
        ].map(([color, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-500">
            <span className="size-1.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function EvidencePanel({
  node,
  onInvestigate
}: {
  node: GraphNode | null;
  onInvestigate?: (caseId: string) => void;
}) {
  if (!node) {
    return (
      <aside className="min-w-0 p-5">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-400">
          Evidence
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
          Select a case, reference, ledger record or currency to inspect the stored fields behind
          the connection.
        </p>
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-[10.5px] text-ink-400">Relationship path</p>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-600">
            Case → reference → ledger record → currency
          </p>
        </div>
      </aside>
    );
  }

  const rows: [string, string][] =
    node.kind === "case"
      ? [
          ["Case ID", node.caseId ?? ""],
          ["Reference", node.reference ?? ""],
          ["Risk score", String(node.score ?? "—")],
          ["Risk level", node.riskLevel ?? "—"],
          ["Priority", node.priority ?? "—"],
          ["Status", node.status ?? "—"],
          ["Currency", node.currency || "Not in loaded records"],
          [
            "Amount",
            node.amountMinor && node.currency
              ? formatMinor(node.amountMinor, node.currency)
              : "—"
          ],
          ["Model", node.modelVersion || "—"],
          ["Created", node.createdAt ? formatDate(node.createdAt) : "—"]
        ]
      : node.kind === "reference"
        ? [
            ["Reference", node.reference ?? ""],
            ["Cases", String(node.matchCount ?? 0)],
            ["Currency", node.currency || "No currency match"],
            ["Matching", "Exact reference from the case"]
          ]
        : node.kind === "transaction"
          ? [
              ["Record ID", node.transaction?.id ?? ""],
              ["Reference", node.reference ?? ""],
              ["Type", node.transaction?.type ?? ""],
              ["Currency", node.currency ?? ""],
              [
                "Amount",
                node.amountMinor && node.currency
                  ? formatMinor(node.amountMinor, node.currency)
                  : "—"
              ],
              ["Status", node.status ?? "—"],
              ["Created", node.createdAt ? formatDate(node.createdAt) : "—"]
            ]
          : [
              ["Currency", node.currency ?? ""],
              ["Records", "Loaded ledger matches"],
              ["Conversion", "None"]
            ];

  return (
    <aside className="flex min-w-0 flex-col">
      <div className="border-b border-border px-5 py-4">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-400">
          {node.kind}
        </p>
        <p className="mt-1 break-all font-mono text-[12px] text-ink-950">{node.label}</p>
        {node.status && (
          <div className="mt-2">
            <StatusBadge status={node.status} />
          </div>
        )}
      </div>
      <dl className="flex-1 divide-y divide-border/70 overflow-y-auto">
        {rows.map(([label, value]) => (
          <div key={label} className="px-5 py-2.5">
            <dt className="text-[10px] text-ink-400">{label}</dt>
            <dd className="mt-0.5 break-all font-mono text-[10.5px] text-ink-800">
              {value || "—"}
            </dd>
          </div>
        ))}
      </dl>
      {node.kind === "case" && node.caseId && onInvestigate && (
        <div className="border-t border-border p-4">
          <Button
            className="h-8 w-full bg-primary text-[11.5px] font-semibold text-primary-foreground"
            onClick={() => onInvestigate(node.caseId!)}
          >
            Open case investigation
            <ArrowRight className="ml-auto size-3.5" />
          </Button>
        </div>
      )}
    </aside>
  );
}

function RecordsTable({
  nodes,
  selectedId,
  onSelect,
  onInvestigate
}: {
  nodes: GraphNode[];
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  onInvestigate?: (caseId: string) => void;
}) {
  const cases = nodes.filter((node) => node.kind === "case");
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 overflow-x-auto border-b border-border lg:border-b-0 lg:border-r">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border bg-paper-muted/60">
            {["Reference", "Risk", "Status", "Currency", "Amount", "Created"].map((heading) => (
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
          {cases.map((node) => (
            <tr
              key={node.id}
              tabIndex={0}
              onClick={() => onSelect(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node);
                }
              }}
              className={cn(
                "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                selectedId === node.id && "bg-primary-soft/40"
              )}
            >
              <td className="px-5 py-3 font-mono text-[11px] text-ink-900">{node.label}</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: riskColor[node.riskLevel ?? "low"] ?? "#5b677f" }}
                  />
                  {node.score}
                </span>
              </td>
              <td className="px-4 py-3 capitalize text-ink-500">{node.status}</td>
              <td className="px-4 py-3 font-mono text-[11px]">{node.currency || "—"}</td>
              <td className="px-4 py-3 font-mono text-[11px]">
                {node.amountMinor && node.currency
                  ? formatMinor(node.amountMinor, node.currency)
                  : "—"}
              </td>
              <td className="px-5 py-3 text-[10.5px] text-ink-400">
                {node.createdAt ? formatDate(node.createdAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <EvidencePanel node={selected} onInvestigate={onInvestigate} />
    </div>
  );
}
