"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Clock3, Fingerprint, LockKeyhole, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { SessionsPanel } from "@/components/settings/sessions-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, errorMessage } from "@/lib/api";
import {
  formatDate,
  formatMinor,
  majorToMinor,
  minorHint,
  minorToMajorInput,
  roleLabel
} from "@/lib/format";
import { canFinance } from "@/lib/roles";
import type { TransactionPolicy } from "@/lib/types";

type PolicyForm = {
  currency: string;
  max_single: string;
  daily_collection: string;
  daily_transfer: string;
  approval_threshold: string;
  required_approvals: string;
};

const emptyForm: PolicyForm = {
  currency: "USD",
  max_single: "",
  daily_collection: "",
  daily_transfer: "",
  approval_threshold: "",
  required_approvals: ""
};

export default function SettingsPage() {
  const { session, role } = useSession();
  const { data, refresh } = useWorkspaceData();
  const canEdit = canFinance(role ?? "");
  const organization = data.organization;
  const [editing, setEditing] = useState<TransactionPolicy | "new" | null>(null);
  const editingPolicy = editing && editing !== "new" ? editing : null;
  const [readOnlyPolicies, setFallbackPolicies] = useState<TransactionPolicy[]>([]);
  const policies = data.policies.length > 0 ? data.policies : readOnlyPolicies;
  const [form, setForm] = useState<PolicyForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Auditors and developers can read policies even though the shared workspace
    // context does not load them for those roles.
    if (!session || canEdit) return;
    let active = true;
    void api<{ data: TransactionPolicy[] }>("/transaction-policies")
      .then((result) => {
        if (active) setFallbackPolicies(result.data ?? []);
      })
      .catch(() => {
        if (active) setFallbackPolicies([]);
      });
    return () => {
      active = false;
    };
  }, [canEdit, session]);

  useEffect(() => {
    if (!editing) return;
    if (editing === "new") {
      setForm(emptyForm);
    } else {
      setForm({
        currency: editing.currency,
        max_single: minorToMajorInput(editing.max_single_minor, editing.currency),
        daily_collection: minorToMajorInput(editing.daily_collection_minor, editing.currency),
        daily_transfer: minorToMajorInput(editing.daily_transfer_minor, editing.currency),
        approval_threshold: minorToMajorInput(editing.approval_threshold_minor, editing.currency),
        required_approvals: String(editing.required_approvals)
      });
    }
    setError("");
  }, [editing]);

  const current = useMemo(
    () =>
      policies.find(
        (item) => item.currency.trim().toUpperCase() === form.currency.trim().toUpperCase()
      ),
    [policies, form.currency]
  );

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    const currency = form.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      setError("Currency must be a three-letter code.");
      return;
    }
    const body: Record<string, string | number> = { currency };
    for (const [field, value] of Object.entries({
      max_single_minor: form.max_single,
      daily_collection_minor: form.daily_collection,
      daily_transfer_minor: form.daily_transfer,
      approval_threshold_minor: form.approval_threshold
    })) {
      if (!value.trim()) continue;
      const minor = majorToMinor(value, currency);
      if (minor == null) {
        setError("Policy limits must be positive amounts.");
        return;
      }
      body[field] = minor;
    }
    if (form.required_approvals.trim()) {
      const reviewers = Number(form.required_approvals);
      if (!Number.isInteger(reviewers) || reviewers < 1 || reviewers > 3) {
        setError("Required reviewers must be a whole number from 1 to 3.");
        return;
      }
      body.required_approvals = reviewers;
    }
    if (Object.keys(body).length === 1) {
      setError("Enter at least one policy value to save.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/transaction-policies", {
        method: "PUT",
        body: JSON.stringify(body)
      });
      toast.success(`Policies for ${currency} saved.`);
      setEditing(null);
      await refresh();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={
          organization?.workspace_type === "personal"
            ? "Personal workspace settings"
            : "Organization settings"
        }
        description="Review workspace details and configure currency-specific transaction controls."
        actions={
          canEdit ? (
            <Button
              className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
              onClick={() => setEditing("new")}
            >
              <Plus className="size-3.5" />
              Add currency policy
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <Panel>
          <PanelHeader
            title="Organization profile"
            description="Tenant and workspace details for this session"
            action={<span className="capitalize"><span className="inline-flex items-center gap-1.5 rounded-md border border-mint/20 bg-mint-soft px-1.5 py-0.5 text-[11px] font-medium text-[#0d7a5f]"><span className="size-1.5 rounded-full bg-mint" />{organization?.status ?? "active"}</span></span>}
          />
          <dl className="divide-y divide-border">
            {[
              {
                icon: Building2,
                label: organization?.workspace_type === "personal" ? "Personal workspace" : "Organization",
                value: organization?.name ?? "Unavailable"
              },
              { icon: Fingerprint, label: "Organization ID", value: organization?.id ?? "—", mono: true },
              { icon: Users, label: "Workspace role", value: roleLabel(role ?? "") },
              { icon: Clock3, label: "Created", value: organization ? formatDate(organization.created_at) : "—" }
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-start gap-3 px-5 py-3.5">
                  <Icon className="mt-0.5 size-4 shrink-0 text-ink-400" />
                  <div className="min-w-0">
                    <dt className="text-[10.5px] text-ink-400">{item.label}</dt>
                    <dd
                      className={
                        item.mono
                          ? "mt-0.5 break-all font-mono text-[10.5px] text-ink-800"
                          : "mt-0.5 text-[12.5px] text-ink-900"
                      }
                    >
                      {item.value}
                    </dd>
                  </div>
                </div>
              );
            })}
          </dl>
        </Panel>

        <Panel>
          <PanelHeader
            title="Transaction policies"
            description="Currency-specific controls for sandbox collections and internal transfers."
            action={
              <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-400">
                <LockKeyhole className="size-3.5" />
                {canEdit ? "Finance controls" : "Read only"}
              </span>
            }
          />
          {policies.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[12.5px] font-medium text-ink-900">No currency policies loaded</p>
              <p className="mx-auto mt-1 max-w-[320px] text-[11.5px] leading-relaxed text-ink-400">
                {canEdit
                  ? "Add a currency policy to set limits and reviewer counts."
                  : "Only finance roles can load and change transaction policies."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-paper-muted/60">
                    {["Currency", "Max single", "Daily collection", "Daily transfer", "Approval threshold", "Reviewers", ""].map(
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
                  {policies.map((policy) => (
                    <tr key={policy.currency} className="border-b border-border/70 text-[11.5px] last:border-0">
                      <td className="px-5 py-3 font-mono text-[11px] text-ink-900">
                        {policy.currency}
                      </td>
                      <td className="px-3 py-3 font-mono text-[10.5px]">
                        {policy.max_single_minor != null
                          ? formatMinor(policy.max_single_minor, policy.currency)
                          : "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-[10.5px]">
                        {policy.daily_collection_minor != null
                          ? formatMinor(policy.daily_collection_minor, policy.currency)
                          : "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-[10.5px]">
                        {policy.daily_transfer_minor != null
                          ? formatMinor(policy.daily_transfer_minor, policy.currency)
                          : "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-[10.5px]">
                        {policy.approval_threshold_minor != null
                          ? formatMinor(policy.approval_threshold_minor, policy.currency)
                          : "Environment default"}
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px]">{policy.required_approvals}</td>
                      <td className="px-5 py-3 text-right">
                        {canEdit && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[10.5px]"
                            onClick={() => setEditing(policy)}
                          >
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-border px-5 py-2.5">
            <p className="text-[10.5px] leading-relaxed text-ink-400">
              Limits are stored in minor units and shown here in each currency&apos;s display units.
              Changes are recorded in the organization audit log.
            </p>
          </div>
        </Panel>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[10.5px] leading-relaxed text-ink-400">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
        This workspace is sandbox-only. Limits govern simulated ledger operations and do not
        authorize or execute external payments.
      </p>

      <SecurityPanel />
      <SessionsPanel />

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">
              {editing === "new" ? "Add currency policy" : `Edit ${form.currency} policy`}
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              Enter amounts in major units. Leave a field blank to keep its current value.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="policy-currency">Currency code</Label>
              <Input
                id="policy-currency"
                value={form.currency}
                onChange={(event) =>
                  setForm({ ...form, currency: event.target.value.toUpperCase().slice(0, 3) })
                }
                maxLength={3}
                required
                disabled={editing !== "new"}
                className="h-9 font-mono text-[12px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["max_single", "Max single transaction"],
                ["daily_collection", "Daily collection cap"],
                ["daily_transfer", "Daily transfer cap"],
                ["approval_threshold", "Approval threshold"]
              ].map(([field, label]) => {
                const key = field as keyof PolicyForm;
                const policyValue = editingPolicy
                  ? editingPolicy[
                      field === "max_single"
                        ? "max_single_minor"
                        : field === "daily_collection"
                          ? "daily_collection_minor"
                          : field === "daily_transfer"
                            ? "daily_transfer_minor"
                            : "approval_threshold_minor"
                    ]
                  : null;
                return (
                  <div key={field} className="space-y-2">
                    <Label htmlFor={`policy-${field}`}>{label}</Label>
                    <Input
                      id={`policy-${field}`}
                      inputMode="decimal"
                      value={form[key] as string}
                      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                      placeholder={
                        policyValue != null
                          ? formatMinor(policyValue, form.currency)
                          : "No limit"
                      }
                      className="h-9 font-mono text-[12px]"
                    />
                    <p className="text-[10px] text-ink-400">
                      {minorHint(form[key] as string, form.currency)}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="space-y-2">
              <Label htmlFor="policy-reviewers">Required reviewers</Label>
              <Input
                id="policy-reviewers"
                type="number"
                min="1"
                max="3"
                step="1"
                value={form.required_approvals}
                onChange={(event) => setForm({ ...form, required_approvals: event.target.value })}
                placeholder={editingPolicy ? String(editingPolicy.required_approvals) : "1"}
                className="h-9 font-mono text-[12px]"
              />
            </div>
            {current && (
              <p className="text-[10.5px] text-ink-400">
                Current configuration loaded for {current.currency}. Blank fields preserve stored
                values.
              </p>
            )}
            {error && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {saving ? "Saving…" : "Save policy"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
