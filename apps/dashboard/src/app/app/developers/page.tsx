"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatRelative } from "@/lib/format";
import type { ApiKey, ApiKeySecret } from "@/lib/types";

const SCOPE_GROUPS: { label: string; scopes: string[] }[] = [
  { label: "Customers", scopes: ["customers.read", "customers.create"] },
  { label: "Accounts", scopes: ["accounts.read", "accounts.create", "accounts.sandbox_credit"] },
  { label: "Collections", scopes: ["collections.read", "collections.create", "collections.cancel", "collections.confirm", "collections.refund"] },
  { label: "Transfers", scopes: ["transfers.read", "transfers.create"] },
  { label: "Ledger and reports", scopes: ["ledger.read", "reports.read"] },
  { label: "Risk", scopes: ["fraud.read", "fraud.analyze"] },
  { label: "Webhooks", scopes: ["webhooks.read", "webhooks.manage"] }
];
const DEFAULT_SCOPES = ["customers.read", "customers.create", "accounts.read", "accounts.create", "collections.read", "collections.create", "transfers.read", "transfers.create", "ledger.read"];

function keyStatus(key: ApiKey) {
  if (key.revoked_at) return "revoked";
  if (key.expires_at && new Date(key.expires_at) <= new Date()) return "expired";
  return "active";
}

export default function DevelopersPage() {
  const { session } = useSession();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [confirm, setConfirm] = useState<{ action: "rotate" | "revoke"; key: ApiKey } | null>(null);
  const [secret, setSecret] = useState<ApiKeySecret | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError("");
    try {
      const result = await api<{ data: ApiKey[] | null }>("/api-keys");
      setKeys(result.data ?? []);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (scopes.length === 0) throw new Error("Choose at least one scope.");
    const body: Record<string, unknown> = { name: name.trim(), scopes };
    if (expiry) body.expires_at = new Date(`${expiry}T23:59:59Z`).toISOString();
    const created = await api<ApiKeySecret>("/api-keys", { method: "POST", body: JSON.stringify(body) });
    setSecret(created);
    setName("");
    setExpiry("");
    setScopes(DEFAULT_SCOPES);
    await load();
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const id = encodeURIComponent(confirm.key.id);
    if (confirm.action === "rotate") {
      const rotated = await api<ApiKeySecret>(`/api-keys/${id}/rotate`, { method: "POST" });
      setSecret(rotated);
    } else {
      await api(`/api-keys/${id}/revoke`, { method: "POST" });
      toast.success(`${confirm.key.name} revoked. Requests using it now fail.`);
    }
    await load();
  };

  const toggle = (scope: string) =>
    setScopes((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));

  return (
    <div>
      <PageHeader
        title="API keys"
        description="Server-to-server credentials for this workspace. Secrets are shown once and stored only as a hash. Sandbox keys start with aegis_test_."
        actions={
          <Button className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            Create API key
          </Button>
        }
      />
      <Panel>
        <PanelHeader title="Keys" description={`${keys.filter((k) => keyStatus(k) === "active").length} active`} />
        {loadError ? (
          <EmptyState icon={KeyRound} title="API keys could not be loaded" text={loadError} />
        ) : keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys" text="Create a key to call the AegisPay API from your servers." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Name", "Prefix", "Scopes", "Status", "Last used", "Expires", ""].map((heading) => (
                    <th key={heading} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const status = keyStatus(key);
                  return (
                    <tr key={key.id} className="border-b border-border/70 text-[12px] last:border-0">
                      <td className="px-5 py-3 font-medium text-ink-900">{key.name}</td>
                      <td className="px-4 py-3 font-mono text-[11px] text-ink-600">{key.key_prefix}…</td>
                      <td className="max-w-[260px] px-4 py-3 text-[10.5px] text-ink-500">{key.scopes.join(", ")}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-3 text-[11px] text-ink-400">{key.last_used_at ? formatRelative(key.last_used_at) : "Never"}</td>
                      <td className="px-4 py-3 text-[11px] text-ink-400">{key.expires_at ? formatDate(key.expires_at) : "No expiry"}</td>
                      <td className="px-5 py-3 text-right">
                        {status === "active" && (
                          <span className="inline-flex gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setConfirm({ action: "rotate", key })}>
                              Rotate
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 border-coral/30 text-[11px] text-coral" onClick={() => setConfirm({ action: "revoke", key })}>
                              Revoke
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <FormDialog open={createOpen} onOpenChange={setCreateOpen} title="Create an API key" description="Grant only the scopes this integration needs." submitLabel="Create key" onSubmit={create}>
        <Field id="key-name" label="Name" required placeholder="Billing service" value={name} onChange={(e) => setName(e.target.value)} />
        <Field id="key-expiry" label="Expires on (optional)" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} hint="Leave blank for no expiry. Keys can be rotated at any time." />
        <fieldset className="space-y-2">
          <legend className="text-[12px] font-medium">Scopes</legend>
          <div className="max-h-[220px] space-y-2 overflow-y-auto rounded-md border border-border p-3">
            {SCOPE_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-[10.5px] font-medium uppercase tracking-wide text-ink-400">{group.label}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {group.scopes.map((scope) => (
                    <label key={scope} className="flex items-center gap-1.5 text-[11.5px]">
                      <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
                      <span className="font-mono">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      </FormDialog>

      <FormDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={confirm?.action === "rotate" ? `Rotate ${confirm.key.name}` : `Revoke ${confirm?.key.name ?? ""}`}
        description={
          confirm?.action === "rotate"
            ? "The current secret stops working immediately and a replacement with the same scopes is created. Update your integration with the new secret."
            : "Requests using this key fail immediately. This cannot be undone."
        }
        destructive
        submitLabel={confirm?.action === "rotate" ? "Rotate key" : "Revoke key"}
        onSubmit={runConfirm}
      >
        <></>
      </FormDialog>

      <Dialog open={secret !== null} onOpenChange={(next) => !next && setSecret(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Copy your secret now</DialogTitle>
            <DialogDescription className="text-[12px]">
              {secret?.replaces ? "The previous key was revoked. " : ""}This is the only time the secret is shown. Store it in your secrets manager.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-paper-muted p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11.5px]">{secret?.secret}</code>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => {
                void navigator.clipboard.writeText(secret?.secret ?? "");
                toast.success("Secret copied.");
              }}
            >
              <Copy className="size-3" />
              Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-ink-900 p-3 text-[10.5px] text-on-night">{`curl https://aegispay.fly.dev/v1/accounts \\
  -H "Authorization: Bearer ${secret?.secret ?? ""}"`}</pre>
          <div className="flex justify-end">
            <Button className="h-9 text-[12px]" onClick={() => setSecret(null)}>
              I have stored it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
