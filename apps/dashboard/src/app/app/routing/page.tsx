"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { formatMinor, majorToMinor, minorHint } from "@/lib/format";
import type { RoutingAction, RoutingRule } from "@/lib/types";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "aegispay.routing.rules";

const defaultRules: RoutingRule[] = [
  {
    id: "rule-review-large",
    label: "Large RWF payments need review",
    currency: "RWF",
    minMinor: 5_000_000,
    maxMinor: null,
    country: "RW",
    action: "review",
    enabled: true
  },
  {
    id: "rule-prefer-small",
    label: "Standard RWF collections",
    currency: "RWF",
    minMinor: null,
    maxMinor: 5_000_000,
    country: "RW",
    action: "prefer",
    enabled: true
  },
  {
    id: "rule-hold-other",
    label: "Hold other currencies",
    currency: "*",
    minMinor: null,
    maxMinor: null,
    country: "*",
    action: "hold",
    enabled: true
  }
];

function loadRules(): RoutingRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRules;
    const parsed = JSON.parse(raw) as RoutingRule[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultRules;
  } catch {
    return defaultRules;
  }
}

export default function RoutingPage() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [addOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    label: "",
    currency: "RWF",
    min: "",
    max: "",
    country: "RW",
    action: "review" as RoutingAction
  });
  const [test, setTest] = useState({ amount: "", currency: "RWF", country: "RW" });

  useEffect(() => {
    setRules(loadRules());
  }, []);

  useEffect(() => {
    if (rules.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);

  const addRule = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.label.trim()) {
      toast.error("Add a rule label.");
      return;
    }
    if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) {
      toast.error("Currency must be a three-letter code or *.");
      return;
    }
    const minMinor = form.min ? majorToMinor(form.min, form.currency) : null;
    const maxMinor = form.max ? majorToMinor(form.max, form.currency) : null;
    if (form.min && minMinor == null) {
      toast.error("Enter a valid minimum amount.");
      return;
    }
    if (form.max && maxMinor == null) {
      toast.error("Enter a valid maximum amount.");
      return;
    }
    setRules((current) => [
      ...current,
      {
        id: `rule-${Date.now()}`,
        label: form.label.trim(),
        currency: form.currency.trim().toUpperCase(),
        minMinor,
        maxMinor,
        country: form.country.trim().toUpperCase() || "*",
        action: form.action,
        enabled: true
      }
    ]);
    setCreateOpen(false);
    setForm({ label: "", currency: "RWF", min: "", max: "", country: "RW", action: "review" });
    toast.success("Preview rule added in this browser.");
  };

  const result = useMemo(() => {
    const currency = test.currency.trim().toUpperCase();
    const country = test.country.trim().toUpperCase();
    const amount = majorToMinor(test.amount, currency === "*" ? "RWF" : currency);
    if (amount == null) return null;
    const rule = rules.find((item) => {
      if (!item.enabled) return false;
      if (item.currency !== "*" && item.currency !== currency) return false;
      if (item.country !== "*" && item.country !== country) return false;
      if (item.minMinor != null && amount < item.minMinor) return false;
      if (item.maxMinor != null && amount > item.maxMinor) return false;
      return true;
    });
    return { amount, rule: rule ?? null };
  }, [rules, test]);

  return (
    <div>
      <PageHeader
        title="Routing preview"
        description="Ordered rules evaluated in this browser. No live provider connectors are configured in this sandbox, so the result is a preview of rule eligibility."
        actions={
          <Button
            className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            Add rule
          </Button>
        }
      />

      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber/20 bg-amber-soft/60 px-3.5 py-2.5">
        <Workflow className="mt-0.5 size-4 shrink-0 text-amber" />
        <p className="text-[11.5px] leading-relaxed text-[#7a5210]">
          Rules are stored in this browser only and are not sent to the server. No provider
          availability, cost or success rate is represented.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <Panel>
          <PanelHeader
            title="Ordered rules"
            description={`${rules.length} rule${rules.length === 1 ? "" : "s"} · first match wins`}
          />
          {rules.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="No preview rules"
              text="Add a rule to evaluate an amount, currency and country in this browser."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-paper-muted/60">
                    {["Order", "Rule", "Currency", "Amount band", "Country", "Action", "Enabled", ""].map(
                      (heading) => (
                        <th
                          key={heading}
                          className="px-3 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5"
                        >
                          {heading}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr key={rule.id} className="border-b border-border/70 text-[11.5px] last:border-0">
                      <td className="px-5 py-3 font-mono text-[10.5px] text-ink-400">
                        {String(index + 1).padStart(2, "0")}
                      </td>
                      <td className="px-3 py-3 text-ink-800">{rule.label}</td>
                      <td className="px-3 py-3 font-mono text-[11px]">{rule.currency}</td>
                      <td className="px-3 py-3 font-mono text-[10.5px] text-ink-500">
                        {rule.minMinor == null && rule.maxMinor == null
                          ? "Any"
                          : `${rule.minMinor != null ? formatMinor(rule.minMinor, rule.currency === "*" ? "RWF" : rule.currency) : "No min"} – ${
                              rule.maxMinor != null
                                ? formatMinor(rule.maxMinor, rule.currency === "*" ? "RWF" : rule.currency)
                                : "no max"
                            }`}
                      </td>
                      <td className="px-3 py-3 font-mono text-[10.5px]">{rule.country}</td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] capitalize",
                            rule.action === "review"
                              ? "border-amber/25 bg-amber-soft text-[#8a5a12]"
                              : rule.action === "prefer"
                                ? "border-mint/25 bg-mint-soft text-[#0d7a5f]"
                                : "border-border bg-paper-muted text-ink-500"
                          )}
                        >
                          {rule.action}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          aria-pressed={rule.enabled}
                          onClick={() =>
                            setRules((current) =>
                              current.map((item) =>
                                item.id === rule.id ? { ...item, enabled: !item.enabled } : item
                              )
                            )
                          }
                          className={cn(
                            "relative h-5 w-9 rounded-full border transition-colors",
                            rule.enabled
                              ? "border-mint/30 bg-mint/20"
                              : "border-border bg-paper-muted"
                          )}
                        >
                          <span
                            className={cn(
                              "absolute top-0.5 size-3.5 rounded-full transition-all",
                              rule.enabled ? "left-[18px] bg-mint" : "left-0.5 bg-ink-300"
                            )}
                          />
                          <span className="sr-only">Toggle {rule.label}</span>
                        </button>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          aria-label={`Delete rule ${rule.label}`}
                          onClick={() =>
                            setRules((current) => current.filter((item) => item.id !== rule.id))
                          }
                          className="text-ink-300 hover:text-coral"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-border px-5 py-2.5 text-[10.5px] text-ink-400">
            Rules persist in this browser. Clearing site data restores the defaults.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Evaluate a preview" description="No network request is made" />
          <div className="space-y-3 p-5">
            <div className="space-y-2">
              <Label htmlFor="routing-amount">Amount (major units)</Label>
              <Input
                id="routing-amount"
                inputMode="decimal"
                value={test.amount}
                onChange={(event) => setTest({ ...test, amount: event.target.value })}
                placeholder="e.g. 4200"
                className="h-9 font-mono text-[12px]"
              />
              <p className="text-[10.5px] text-ink-400">{minorHint(test.amount, test.currency)}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="routing-currency">Currency</Label>
                <Input
                  id="routing-currency"
                  value={test.currency}
                  onChange={(event) =>
                    setTest({ ...test, currency: event.target.value.toUpperCase().slice(0, 3) })
                  }
                  maxLength={3}
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="routing-country">Country</Label>
                <Input
                  id="routing-country"
                  value={test.country}
                  onChange={(event) =>
                    setTest({ ...test, country: event.target.value.toUpperCase().slice(0, 2) })
                  }
                  maxLength={2}
                  className="h-9 font-mono text-[12px]"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-paper p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400">
                  Preview
                </span>
                <span className="rounded border border-primary/20 bg-primary-soft px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[#4436cf]">
                  Not routed
                </span>
              </div>
              {!result ? (
                <p className="mt-2 text-[11.5px] text-ink-400">
                  Enter a positive amount to evaluate the rules.
                </p>
              ) : result.rule ? (
                <div className="mt-2">
                  <p className="text-[12.5px] font-medium capitalize text-ink-900">
                    {result.rule.action}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-500">{result.rule.label}</p>
                  <p className="mt-1 font-mono text-[10.5px] text-ink-400">
                    {formatMinor(result.amount, test.currency)} · {test.currency} · {test.country}
                  </p>
                </div>
              ) : (
                <div className="mt-2">
                  <p className="text-[12.5px] font-medium text-ink-900">No rule matched</p>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    Add a catch-all rule or change the test values.
                  </p>
                </div>
              )}
            </div>
            <p className="text-[10.5px] leading-relaxed text-ink-400">
              Amounts are converted to minor units using the currency&apos;s display fraction
              digits. No provider is selected.
            </p>
          </div>
        </Panel>
      </div>

      <Dialog open={addOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Add a preview rule</DialogTitle>
            <DialogDescription className="text-[12px]">
              Stored in this browser. No server request is made.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addRule} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="rule-label">Label</Label>
              <Input
                id="rule-label"
                value={form.label}
                onChange={(event) => setForm({ ...form, label: event.target.value })}
                required
                className="h-9 text-[12px]"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="rule-currency">Currency</Label>
                <Input
                  id="rule-currency"
                  value={form.currency}
                  onChange={(event) =>
                    setForm({ ...form, currency: event.target.value.toUpperCase().slice(0, 3) })
                  }
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rule-country">Country</Label>
                <Input
                  id="rule-country"
                  value={form.country}
                  onChange={(event) =>
                    setForm({ ...form, country: event.target.value.toUpperCase().slice(0, 2) })
                  }
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rule-action">Action</Label>
                <Select
                  value={form.action}
                  onValueChange={(value) => setForm({ ...form, action: value as RoutingAction })}
                >
                  <SelectTrigger id="rule-action" className="h-9 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prefer">Prefer</SelectItem>
                    <SelectItem value="review">Review</SelectItem>
                    <SelectItem value="hold">Hold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="rule-min">Minimum (major)</Label>
                <Input
                  id="rule-min"
                  inputMode="decimal"
                  value={form.min}
                  onChange={(event) => setForm({ ...form, min: event.target.value })}
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rule-max">Maximum (major)</Label>
                <Input
                  id="rule-max"
                  inputMode="decimal"
                  value={form.max}
                  onChange={(event) => setForm({ ...form, max: event.target.value })}
                  className="h-9 font-mono text-[12px]"
                />
              </div>
            </div>
            <p className="text-[10.5px] text-ink-400">
              {form.min || form.max
                ? `${form.min ? minorHint(form.min, form.currency) : "No minimum"} · ${
                    form.max ? minorHint(form.max, form.currency) : "no maximum"
                  }`
                : "Leave both blank for any amount."}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground">
                Add rule
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
