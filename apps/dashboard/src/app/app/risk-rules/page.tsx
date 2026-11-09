"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, LayoutTemplate, Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog, SelectField } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatMinor, majorToMinor, minorToMajorInput } from "@/lib/format";
import { canReviewFraud } from "@/lib/roles";
import type { RiskAction, RiskEvaluation, RiskRule, RiskRuleTemplate, RiskSubjectKind } from "@/lib/types";

const KINDS: RiskSubjectKind[] = ["collection", "transfer", "payout"];
const ACTION_TONE: Record<RiskAction, "success" | "warning" | "danger"> = { allow: "success", review: "warning", block: "danger" };

type RuleForm = {
  name: string;
  appliesTo: RiskSubjectKind[];
  currency: string;
  min: string;
  max: string;
  velocityCount: string;
  velocityWindow: string;
  action: RiskAction;
  priority: string;
};

const emptyForm: RuleForm = { name: "", appliesTo: ["transfer"], currency: "", min: "", max: "", velocityCount: "", velocityWindow: "", action: "review", priority: "100" };

// Without a currency, amounts are entered in minor units because the number
// of decimals depends on the currency.
function toMinor(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  if (!currency) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Without a currency, enter amounts in minor units (whole numbers).");
    return parsed;
  }
  const minor = majorToMinor(value, currency);
  if (minor == null) throw new Error("Enter positive amounts.");
  return minor;
}

function describe(rule: RiskRule) {
  const parts: string[] = [];
  if (rule.currency) parts.push(rule.currency);
  const amount = (minor: number) => (rule.currency ? formatMinor(minor, rule.currency) : `${minor.toLocaleString()} minor units`);
  if (rule.min_amount_minor != null) parts.push(`from ${amount(rule.min_amount_minor)}`);
  if (rule.max_amount_minor != null) parts.push(`up to ${amount(rule.max_amount_minor)}`);
  if (rule.velocity_count != null) parts.push(`more than ${rule.velocity_count} in ${rule.velocity_window_minutes} min`);
  return parts.length ? parts.join(" · ") : "Every record";
}

export default function RiskRulesPage() {
  const { session, role } = useSession();
  const canManage = canReviewFraud(role ?? undefined);
  const [rules, setRules] = useState<RiskRule[]>([]);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<RiskRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<RiskRule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [test, setTest] = useState({ kind: "transfer" as RiskSubjectKind, amount: "", currency: "USD" });
  const [result, setResult] = useState<RiskEvaluation | null>(null);
  const [testing, setTesting] = useState(false);
  const [templates, setTemplates] = useState<RiskRuleTemplate[]>([]);
  const [applying, setApplying] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError("");
    try {
      setRules((await api<{ data: RiskRule[] }>("/risk-rules")).data);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!session || !canManage) return;
    void api<{ data: RiskRuleTemplate[] }>("/risk-rules/templates")
      .then((result) => setTemplates(result.data))
      .catch(() => setTemplates([]));
  }, [session, canManage]);

  const applyTemplate = async (template: RiskRuleTemplate) => {
    setApplying(template.id);
    try {
      const result = await api<{ created: number; already_present: number }>(
        `/risk-rules/templates/${encodeURIComponent(template.id)}/apply`,
        { method: "POST", body: JSON.stringify({ currency: template.currency }) }
      );
      toast.success(
        result.created === 0
          ? `All ${template.name} rules were already here.`
          : `${result.created} ${template.name} ${result.created === 1 ? "rule" : "rules"} added${result.already_present ? `; ${result.already_present} already here` : ""}.`
      );
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setApplying("");
    }
  };

  const openEdit = (rule: RiskRule | "new") => {
    if (rule === "new") setForm(emptyForm);
    else
      setForm({
        name: rule.name,
        appliesTo: rule.applies_to,
        currency: rule.currency ?? "",
        min: rule.min_amount_minor == null ? "" : rule.currency ? minorToMajorInput(rule.min_amount_minor, rule.currency) : String(rule.min_amount_minor),
        max: rule.max_amount_minor == null ? "" : rule.currency ? minorToMajorInput(rule.max_amount_minor, rule.currency) : String(rule.max_amount_minor),
        velocityCount: rule.velocity_count?.toString() ?? "",
        velocityWindow: rule.velocity_window_minutes?.toString() ?? "",
        action: rule.action,
        priority: String(rule.priority)
      });
    setEditing(rule);
  };

  const body = (f: RuleForm, enabled: boolean) => {
    const currency = f.currency.trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter ISO 4217 code, or blank for any.");
    return {
      name: f.name.trim(),
      enabled,
      priority: Number(f.priority) || 100,
      applies_to: f.appliesTo,
      currency: currency || null,
      min_amount_minor: toMinor(f.min, currency),
      max_amount_minor: toMinor(f.max, currency),
      velocity_count: f.velocityCount ? Number(f.velocityCount) : null,
      velocity_window_minutes: f.velocityWindow ? Number(f.velocityWindow) : null,
      action: f.action
    };
  };

  const save = async () => {
    if (editing === "new") {
      await api("/risk-rules", { method: "POST", body: JSON.stringify(body(form, true)) });
      toast.success("Rule created. It applies to new records immediately.");
    } else if (editing) {
      await api(`/risk-rules/${encodeURIComponent(editing.id)}`, { method: "PUT", body: JSON.stringify(body(form, editing.enabled)) });
      toast.success("Rule updated.");
    }
    await load();
  };

  const toggle = async (rule: RiskRule) => {
    try {
      const { id, created_at: _c, updated_at: _u, ...rest } = rule;
      await api(`/risk-rules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ ...rest, enabled: !rule.enabled }) });
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const runTest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const currency = test.currency.trim().toUpperCase();
    const amount = majorToMinor(test.amount, currency);
    if (amount == null || !/^[A-Z]{3}$/.test(currency)) {
      toast.error("Enter a positive amount and a three-letter currency.");
      return;
    }
    setTesting(true);
    try {
      setResult(await api<RiskEvaluation>("/risk-rules/evaluate", { method: "POST", body: JSON.stringify({ kind: test.kind, amount, currency }) }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Risk rules"
        description="Checked on the server before a collection, transfer or payout is recorded. The strictest match wins: block refuses the request, review opens a case and holds posting until someone decides."
        actions={
          canManage ? (
            <Button className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground" onClick={() => openEdit("new")}>
              <Plus className="size-3.5" />
              New rule
            </Button>
          ) : undefined
        }
      />
      {canManage && templates.length > 0 && (
        <Panel className="mb-4">
          <PanelHeader
            title="Start from a template"
            description={`Ready-made rules for common kinds of organizations, with limits in ${templates[0].currency}. They ask for review rather than block, and you can edit them afterwards.`}
          />
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-col rounded-lg border border-border bg-paper px-4 py-3">
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-900">
                  <LayoutTemplate className="size-3.5 text-primary" aria-hidden />
                  {template.name}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{template.description}</p>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-ink-400 hover:text-ink-700">
                    {template.rules.length} rules
                  </summary>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-600">
                    {template.rules.map((rule) => (
                      <li key={rule.name}>{rule.name}</li>
                    ))}
                  </ul>
                </details>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 h-8 self-start text-[11.5px]"
                  disabled={applying !== ""}
                  onClick={() => void applyTemplate(template)}
                >
                  {applying === template.id ? "Adding…" : "Add these rules"}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel>
          <PanelHeader title="Rules" description={`${rules.filter((r) => r.enabled).length} enabled · evaluated by priority`} />
          {loadError ? (
            <EmptyState icon={ShieldAlert} title="Rules could not be loaded" text={loadError} />
          ) : rules.length === 0 ? (
            <EmptyState icon={ShieldAlert} title="No risk rules" text="Without rules, every record is allowed. Start with a review rule for large transfers or a velocity rule for collections." />
          ) : (
            <ul>
              {rules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium text-ink-900">
                      {rule.name}
                      {!rule.enabled && <span className="ml-2 text-[10.5px] font-normal text-ink-400">(disabled)</span>}
                    </p>
                    <p className="text-[11px] text-ink-500">
                      {rule.applies_to.join(", ")} · {describe(rule)} · priority {rule.priority}
                    </p>
                  </div>
                  <StatusBadge status={rule.action} tone={ACTION_TONE[rule.action]} />
                  {canManage && (
                    <span className="inline-flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void toggle(rule)}>
                        {rule.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openEdit(rule)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 border-coral/30 text-[11px] text-coral" onClick={() => setDeleting(rule)}>
                        Delete
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Try a payment" description="Dry run: nothing is recorded" />
          <form onSubmit={runTest} className="space-y-3 p-5">
            <SelectField id="test-kind" label="Type" required value={test.kind} onChange={(value) => setTest({ ...test, kind: value as RiskSubjectKind })} options={KINDS.map((k) => ({ value: k, label: k }))} />
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <Field id="test-amount" label="Amount" inputMode="decimal" required value={test.amount} onChange={(e) => setTest({ ...test, amount: e.target.value })} />
              <Field id="test-currency" label="Currency" required maxLength={3} value={test.currency} onChange={(e) => setTest({ ...test, currency: e.target.value.toUpperCase() })} />
            </div>
            <Button type="submit" disabled={testing} variant="outline" className="h-9 w-full text-[12px]">
              <FlaskConical className="size-3.5" />
              {testing ? "Checking…" : "Evaluate"}
            </Button>
            {result && (
              <div className="rounded-md border border-border p-3" role="status">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium">Decision</span>
                  <StatusBadge status={result.decision} tone={ACTION_TONE[result.decision]} />
                </div>
                {result.matched_rules.length === 0 ? (
                  <p className="mt-2 text-[11px] text-ink-500">No rule matched, so it would be allowed.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {result.matched_rules.map((match) => (
                      <li key={match.id} className="text-[11px] text-ink-600">
                        <span className="font-medium text-ink-900">{match.name}</span> ({match.action}): {match.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </form>
        </Panel>
      </div>

      <FormDialog open={editing !== null} onOpenChange={(next) => !next && setEditing(null)} title={editing === "new" ? "New risk rule" : "Edit risk rule"} description="Every condition you set must hold for the rule to match. Leave a field blank to ignore it." submitLabel={editing === "new" ? "Create rule" : "Save rule"} onSubmit={save}>
        <Field id="rule-name" label="Name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-medium">Applies to</legend>
          <div className="flex gap-4">
            {KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-[12px] capitalize">
                <input type="checkbox" checked={form.appliesTo.includes(kind)} onChange={() => setForm({ ...form, appliesTo: form.appliesTo.includes(kind) ? form.appliesTo.filter((k) => k !== kind) : [...form.appliesTo, kind] })} />
                {kind}s
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-3 gap-3">
          <Field id="rule-currency" label="Currency" placeholder="Any" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
          <Field id="rule-min" label="Min amount" inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
          <Field id="rule-max" label="Max amount" inputMode="decimal" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>Velocity (optional)</Label>
          <div className="flex items-center gap-2 text-[12px] text-ink-500">
            more than
            <Input aria-label="Velocity count" inputMode="numeric" className="h-9 w-20 text-[12px]" value={form.velocityCount} onChange={(e) => setForm({ ...form, velocityCount: e.target.value.replace(/\D/g, "") })} />
            within
            <Input aria-label="Velocity window in minutes" inputMode="numeric" className="h-9 w-20 text-[12px]" value={form.velocityWindow} onChange={(e) => setForm({ ...form, velocityWindow: e.target.value.replace(/\D/g, "") })} />
            minutes
          </div>
          <p className="text-[10.5px] text-ink-400">Counted per customer for collections and per source account for transfers.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField id="rule-action" label="Action" required value={form.action} onChange={(value) => setForm({ ...form, action: value as RiskAction })} options={[{ value: "review", label: "Review (hold for a person)" }, { value: "block", label: "Block" }, { value: "allow", label: "Allow (record only)" }]} />
          <Field id="rule-priority" label="Priority (lower first)" inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value.replace(/\D/g, "") })} />
        </div>
        {!form.currency && (form.min || form.max) && <p className="text-[10.5px] text-amber">Without a currency, amounts are minor units (for example cents).</p>}
      </FormDialog>

      <FormDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)} title={`Delete ${deleting?.name ?? "rule"}`} description="Existing assessments and cases keep their record of this rule." destructive submitLabel="Delete rule" onSubmit={async () => {
        if (!deleting) return;
        await api(`/risk-rules/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
        toast.success("Rule deleted.");
        await load();
      }}>
        <></>
      </FormDialog>
    </div>
  );
}
