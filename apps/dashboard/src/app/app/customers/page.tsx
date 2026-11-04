"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { canFinance } from "@/lib/roles";
import type { Customer, Page } from "@/lib/types";

export default function CustomersPage() {
  const { session, role } = useSession();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const canCreate = canFinance(role ?? undefined);

  const load = useCallback(
    async (after?: string) => {
      if (!session) return;
      setLoading(true);
      setLoadError("");
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (after) query.set("cursor", after);
        const page = await api<Page<Customer>>(`/customers?${query}`);
        setCustomers((current) => (after ? [...current, ...page.data] : page.data));
        setCursor(page.has_more ? page.next_cursor : null);
      } catch (error) {
        setLoadError(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [session]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api<Customer>("/customers", {
        method: "POST",
        body: JSON.stringify({ name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() })
      });
      toast.success(`${form.name.trim()} added.`);
      setCreateOpen(false);
      setForm({ name: "", email: "", phone: "" });
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Customers"
        description="People and businesses you collect from. Link them to collections and wallet accounts."
        actions={
          canCreate ? (
            <Button className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              Add customer
            </Button>
          ) : undefined
        }
      />
      <Panel>
        <PanelHeader title="Customer directory" description={`${customers.length} loaded`} />
        {loadError ? (
          <EmptyState
            icon={Users}
            title="Customers could not be loaded"
            text={loadError}
            action={
              <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        ) : !loading && customers.length === 0 ? (
          <EmptyState icon={Users} title="No customers yet" text="Add a customer to attach collections and accounts to them." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Name", "Email", "Phone", "Status", "Customer ID", "Created"].map((heading) => (
                    <th key={heading} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b border-border/70 text-[12px] last:border-0">
                    <td className="px-5 py-3 font-medium text-ink-900">{customer.name}</td>
                    <td className="px-4 py-3 text-ink-600">{customer.email ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-ink-600">{customer.phone ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={customer.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[10.5px] text-ink-400">{customer.id}</td>
                    <td className="px-5 py-3 text-[11px] text-ink-400">{formatDate(customer.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="outline" className="h-8 text-[11.5px]" disabled={loading} onClick={() => void load(cursor)}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Panel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Add a customer</DialogTitle>
            <DialogDescription className="text-[12px]">Email must be unique within this workspace.</DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customer-name">Name</Label>
              <Input id="customer-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-9 text-[12px]" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-email">Email (optional)</Label>
              <Input id="customer-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="h-9 text-[12px]" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-phone">Phone (optional, international format)</Label>
              <Input id="customer-phone" type="tel" placeholder="+44 20 7946 0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="h-9 text-[12px]" />
            </div>
            {formError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {formError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground">
                {saving ? "Saving…" : "Add customer"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
