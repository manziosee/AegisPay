"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleAlert, Gauge, Network, ScanSearch, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { RiskNetwork, type NetworkLink, type NetworkNode } from "@/components/brand/risk-network";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, errorMessage } from "@/lib/api";
import {
  formatDate,
  majorToMinor,
  minorHint,
  minorToMajorInput,
  formatMinor
} from "@/lib/format";
import { deriveSignals } from "@/lib/signals";
import type { FraudAssessment, FraudCase } from "@/lib/types";
import { cn } from "@/lib/utils";

const severityClass = {
  info: "border-primary/20 bg-primary-soft text-[#4436cf]",
  warning: "border-amber/25 bg-amber-soft text-[#8a5a12]",
  critical: "border-coral/25 bg-coral-soft text-[#a83422]"
} as const;

export default function IntelligencePage() {
  const { session } = useSession();
  const { data, refresh } = useWorkspaceData();
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("RWF");
  const [assessment, setAssessment] = useState<FraudAssessment | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const openCases = data.fraudCases.filter((item) => item.status !== "resolved");
  const selectedCase = openCases.find((item) => item.id === selectedCaseId);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("reference");
    const value = params.get("amount");
    const code = params.get("currency");
    if (ref) setReference(ref);
    if (value) setAmount(minorToMajorInput(Number(value), params.get("currency") ?? "RWF"));
    if (params.get("currency")) setCurrency(params.get("currency")!.toUpperCase());
    if (ref && value) {
      // A command-palette or transaction-detail handoff pre-fills the form only.
      setSelectedCaseId(null);
    }
  }, []);

  useEffect(() => {
    if (selectedCaseId && !openCases.some((item) => item.id === selectedCaseId)) {
      setSelectedCaseId(null);
      setNote("");
    }
  }, [openCases, selectedCaseId]);

  const amountMinor = majorToMinor(amount, currency);
  const signals = assessment
    ? deriveSignals({
        amountMinor: amountMinor ?? assessment.risk_score * 1000,
        currency,
        reference,
        transactions: data.transactions,
        policies: data.policies
      })
    : [];

  const evaluate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const minor = majorToMinor(amount, currency);
    if (!reference.trim()) {
      setError("Enter the transaction reference to evaluate.");
      return;
    }
    if (minor == null) {
      setError("Enter a positive amount in major units.");
      return;
    }
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      setError("Currency must be a three-letter code.");
      return;
    }
    setEvaluating(true);
    setError("");
    try {
      const result = await api<FraudAssessment>("/fraud/analyze", {
        method: "POST",
        body: JSON.stringify({
          transaction_reference: reference.trim(),
          amount: minor,
          currency: currency.trim().toUpperCase()
        })
      });
      setAssessment(result);
      toast.success("Risk assessment recorded.");
      if (result.case_id) {
        setSelectedCaseId(result.case_id);
        await refresh();
      }
    } catch (evaluateError) {
      setAssessment(null);
      setError(errorMessage(evaluateError));
    } finally {
      setEvaluating(false);
    }
  };

  const resolveCase = async (item: FraudCase, outcome: "confirmed" | "false_positive") => {
    if (!session) return;
    if (!note.trim()) {
      setResolveError("Add an investigation note before resolving a fraud case.");
      return;
    }
    setResolving(true);
    setResolveError("");
    try {
      await api(`/fraud/cases/${encodeURIComponent(item.id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ outcome, note: note.trim() })
      });
      toast.success("Fraud case resolved and recorded.");
      setNote("");
      setSelectedCaseId(null);
      await refresh();
    } catch (resolveFailure) {
      setResolveError(errorMessage(resolveFailure));
    } finally {
      setResolving(false);
    }
  };

  const network = useMemo(() => {
    const nodes: NetworkNode[] = [
      { id: "queue", label: "Review queue", x: 500, y: 260, kind: "core", meta: `${openCases.length} open` }
    ];
    const links: NetworkLink[] = [];
    openCases.slice(0, 6).forEach((item, index, list) => {
      const angle = (Math.PI * 2 * index) / Math.max(list.length, 1) - Math.PI / 2;
      nodes.push({
        id: item.id,
        label: item.transaction_reference,
        x: 500 + Math.cos(angle) * 300,
        y: 260 + Math.sin(angle) * 150,
        kind: "risk",
        meta: `score ${item.risk_score}`
      });
      links.push({ from: "queue", to: item.id, tone: "amber" });
    });
    return { nodes, links };
  }, [openCases]);

  return (
    <div>
      <PageHeader
        title="Risk review"
        description="Evaluate a transaction reference, read the stored assessment and investigate review cases. Scores come from the fraud service; extra signals are derived from loaded workspace records."
      />

      <Tabs defaultValue="evaluation">
        <TabsList className="mb-4 h-9 bg-card p-1">
          <TabsTrigger value="evaluation" className="h-7 px-3 text-[12px]">
            <ScanSearch className="size-3.5" />
            Evaluation
          </TabsTrigger>
          <TabsTrigger value="network" className="h-7 px-3 text-[12px]">
            <Network className="size-3.5" />
            Relationship view
          </TabsTrigger>
        </TabsList>

        <TabsContent value="evaluation">
          <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="space-y-4">
              <Panel>
                <PanelHeader
                  title="Evaluate a transaction"
                  description="POST /v1/fraud/analyze"
                  action={<StatusBadge status="preview" label="Sandbox" tone="info" />}
                />
                <form onSubmit={evaluate} className="space-y-4 p-5">
                  <div className="space-y-2">
                    <Label htmlFor="risk-reference">Transaction reference</Label>
                    <Input
                      id="risk-reference"
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder="e.g. COL-2048"
                      required
                      className="h-9 font-mono text-[12px]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="risk-amount">Amount (major units)</Label>
                      <Input
                        id="risk-amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder="e.g. 4200"
                        required
                        className="h-9 font-mono text-[12px]"
                      />
                      <p className="text-[10.5px] text-ink-400">{minorHint(amount, currency)}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="risk-currency">Currency</Label>
                      <Input
                        id="risk-currency"
                        value={currency}
                        onChange={(event) =>
                          setCurrency(event.target.value.toUpperCase().slice(0, 3))
                        }
                        maxLength={3}
                        required
                        className="h-9 font-mono text-[12px]"
                      />
                    </div>
                  </div>
                  {error && (
                    <p
                      role="alert"
                      className="flex items-start gap-2 rounded-md border border-coral/20 bg-coral-soft px-3 py-2 text-[11.5px] leading-relaxed text-[#a83422]"
                    >
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      {error}
                    </p>
                  )}
                  <Button
                    type="submit"
                    disabled={evaluating}
                    className="h-9 w-full bg-primary text-[12.5px] font-semibold text-primary-foreground"
                  >
                    {evaluating ? "Evaluating…" : "Evaluate transaction"}
                    <ArrowRight className="ml-auto size-3.5" />
                  </Button>
                </form>
              </Panel>

              <Panel>
                <PanelHeader
                  title="Open cases"
                  description={`${openCases.length} case${openCases.length === 1 ? "" : "s"} awaiting a decision`}
                />
                {openCases.length === 0 ? (
                  <EmptyState
                    icon={ShieldAlert}
                    title="No open cases"
                    text="New cases marked for review by the risk service will appear here."
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {openCases.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCaseId(item.id);
                            setNote("");
                            setResolveError("");
                          }}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
                            selectedCaseId === item.id
                              ? "bg-primary-soft/50"
                              : "hover:bg-paper-muted/60"
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[11.5px] text-ink-900">
                              {item.transaction_reference}
                            </span>
                            <span className="mt-0.5 block text-[10.5px] text-ink-400">
                              {formatDate(item.created_at)} · {item.risk_level} risk
                            </span>
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[15px] text-ink-900">
                              {item.risk_score}
                            </span>
                            <StatusBadge status={item.priority} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel>
                <PanelHeader
                  title="Assessment result"
                  description="Stored by the fraud service"
                  action={
                    assessment ? (
                      <StatusBadge
                        status={assessment.decision}
                        label={assessment.decision}
                        tone={
                          assessment.decision === "allow"
                            ? "success"
                            : assessment.decision === "review"
                              ? "warning"
                              : "danger"
                        }
                      />
                    ) : undefined
                  }
                />
                {!assessment ? (
                  <EmptyState
                    icon={Gauge}
                    title="No assessment yet"
                    text="Run an evaluation to see the score, decision, level and model version returned by the fraud service."
                  />
                ) : (
                  <div className="p-5">
                    <div className="flex flex-wrap items-center gap-6">
                      <RiskGauge score={assessment.risk_score} />
                      <div className="min-w-[160px] flex-1 space-y-3">
                        <div>
                          <p className="text-[11px] text-ink-400">Transaction reference</p>
                          <p className="mt-0.5 font-mono text-[12px] text-ink-900">
                            {assessment.transaction_reference}
                          </p>
                        </div>
                        <dl className="grid grid-cols-2 gap-3">
                          <div>
                            <dt className="text-[11px] text-ink-400">Level</dt>
                            <dd className="mt-0.5 text-[12px] capitalize text-ink-800">
                              {assessment.risk_level}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-ink-400">Model</dt>
                            <dd className="mt-0.5 font-mono text-[11px] text-ink-800">
                              {assessment.model_version}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-ink-400">Mode</dt>
                            <dd className="mt-0.5 font-mono text-[11px] text-ink-800">
                              {assessment.mode}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-ink-400">Case</dt>
                            <dd className="mt-0.5 truncate font-mono text-[11px] text-ink-800">
                              {assessment.case_id ?? "No case opened"}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    <div className="mt-5 border-t border-border pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-[12.5px] font-medium text-ink-900">Signals</h3>
                        <span className="font-mono text-[10px] text-ink-400">
                          Derived in browser from workspace records
                        </span>
                      </div>
                      {signals.length === 0 ? (
                        <p className="mt-2 text-[11.5px] text-ink-400">
                          No additional signals were derived from the loaded records. The fraud
                          service response is shown above unchanged.
                        </p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {signals.map((signal) => (
                            <li key={signal.code} className="rounded-lg border border-border p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-mono text-[10.5px] text-ink-700">
                                  {signal.code}
                                </span>
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                                    severityClass[signal.severity]
                                  )}
                                >
                                  {signal.observed}
                                </span>
                              </div>
                              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
                                {signal.description}
                              </p>
                              <p className="mt-1 font-mono text-[10px] text-ink-400">
                                Basis: {signal.basis}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </Panel>

              {selectedCase && (
                <Panel>
                  <PanelHeader
                    title="Case investigation"
                    description={`${selectedCase.transaction_reference} · score ${selectedCase.risk_score}`}
                    action={<StatusBadge status={selectedCase.priority} />}
                  />
                  <div className="space-y-3 p-5">
                    <div className="space-y-2">
                      <Label htmlFor="investigation-note">Investigation note</Label>
                      <Textarea
                        id="investigation-note"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Record the evidence and reasoning for your decision…"
                        className="min-h-[80px] text-[12px]"
                      />
                    </div>
                    {resolveError && (
                      <p role="alert" className="text-[11.5px] text-destructive">
                        {resolveError}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        className="h-8 text-[11.5px]"
                        disabled={resolving}
                        onClick={() => void resolveCase(selectedCase, "false_positive")}
                      >
                        False positive
                      </Button>
                      <Button
                        variant="outline"
                        className="h-8 border-coral/30 text-[11.5px] text-coral hover:bg-coral-soft"
                        disabled={resolving}
                        onClick={() => void resolveCase(selectedCase, "confirmed")}
                      >
                        {resolving ? "Saving…" : "Confirm suspicious"}
                      </Button>
                    </div>
                  </div>
                </Panel>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="network">
          <Panel>
            <PanelHeader
              title="Relationship view"
              description="Loaded review cases connected to this workspace's review queue"
              action={<StatusBadge status="preview" label="Loaded records" tone="info" />}
            />
            {openCases.length === 0 ? (
              <EmptyState
                icon={Network}
                title="No relationships to show"
                text="Relationships appear when review cases are loaded. The view does not invent account or transaction links."
              />
            ) : (
              <div className="p-4">
                <RiskNetwork nodes={network.nodes} links={network.links} tone="light" compact />
                <p className="mt-2 text-[10.5px] leading-relaxed text-ink-400">
                  Lines connect each loaded case to the review queue. No external relationship is
                  implied.
                </p>
              </div>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RiskGauge({ score }: { score: number }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(100, Math.max(0, score)) / 100) * circumference;
  const color = score >= 70 ? "#d9452f" : score >= 40 ? "#b7791f" : "#13b58c";
  return (
    <div className="relative grid size-[116px] place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#f1efe9" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div className="relative text-center">
        <p className="font-mono text-[30px] font-medium leading-none text-ink-950">{score}</p>
        <p className="mt-0.5 text-[9.5px] uppercase tracking-[0.1em] text-ink-400">Risk score</p>
      </div>
    </div>
  );
}
