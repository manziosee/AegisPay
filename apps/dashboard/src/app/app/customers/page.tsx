"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Eye, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMinor, statusLabel } from "@/lib/format";
import { canFinance } from "@/lib/roles";
import type { Customer, CustomerDetail, Page } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "active" | "archived" | "all";
const emptyForm = { name: "", email: "", phone: "" };

export default function CustomersPage() {
  const { session, role } = useSession();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [removing, setRemoving] = useState<Customer | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const canManage = canFinance(role ?? undefined);

  const load = useCallback(
    async (after?: string) => {
      if (!session) return;
      setLoading(true);
      setLoadError("");
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (after) params.set("cursor", after);
        const page = await api<Page<Customer>>(`/customers?${params}`);
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

  const loadDetail = useCallback(async (id: string) => {
    setDetailError("");
    try {
      setDetail(await api<CustomerDetail>(`/customers/${encodeURIComponent(id)}`));
    } catch (error) {
      setDetailError(errorMessage(error));
    }
  }, []);

  const view = (customer: Customer) => {
    setDetail(null);
    setViewingId(customer.id);
    void loadDetail(customer.id);
  };

  const replace = (updated: Partial<Customer> & { id: string }) => {
    setCustomers((current) => current.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
    if (viewingId === updated.id) void loadDetail(updated.id);
  };

  const setStatus = async (customer: Customer, status: "active" | "archived") => {
    try {
      const updated = await api<Customer>(`/customers/${encodeURIComponent(customer.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      replace(updated);
      toast.success(status === "archived" ? `${customer.name} archived.` : `${customer.name} restored.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return customers.filter((customer) => {
      if (filter !== "all" && (customer.status === "archived") !== (filter === "archived")) return false;
      if (!needle) return true;
      return [customer.name, customer.email ?? "", customer.phone ?? "", customer.id].some((value) =>
        value.toLowerCase().includes(needle)
      );
    });
  }, [customers, filter, query]);

  const counts = useMemo(
    () => ({
      active: customers.filter((c) => c.status !== "archived").length,
      archived: customers.filter((c) => c.status === "archived").length
    }),
    [customers]
  );

  const viewing = customers.find((item) => item.id === viewingId) ?? null;

  return (
    <div>
      <PageHeader
        title="Customers"
        description="People and businesses you collect from. Open one to see their accounts, balances and payment history."
        actions={
          canManage ? (
            <Button
              className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
              onClick={() => {
                setForm(emptyForm);
                setCreating(true);
              }}
            >
              <Plus className="size-3.5" />
              Add customer
            </Button>
          ) : undefined
        }
      />
      <Panel>
        <PanelHeader
          title="Customer directory"
          description={`${counts.active} active · ${counts.archived} archived${cursor ? " · more to load" : ""}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search customers"
                placeholder="Search name, email or phone"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-[200px] bg-card text-[11.5px]"
              />
              <div role="group" aria-label="Show customers" className="flex rounded-md border border-border bg-card p-0.5">
                {(["active", "archived", "all"] as Filter[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "rounded px-2.5 py-1 text-[11px] capitalize text-ink-500",
                      filter === value && "bg-paper-muted font-medium text-ink-900"
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          }
        />
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
        ) : !loading && shown.length === 0 ? (
          <EmptyState
            icon={Users}
            title={customers.length === 0 ? "No customers yet" : "No customers match"}
            text={
              customers.length === 0
                ? "Add a customer to attach payment requests and accounts to them."
                : "Change the search or the filter to see more."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Name", "Email", "Phone", "Status", "Added", ""].map((heading, index) => (
                    <th key={heading || index} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((customer) => (
                  <tr
                    key={customer.id}
                    className="cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/40"
                    onClick={() => view(customer)}
                  >
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        className="text-left font-medium text-ink-900 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          view(customer);
                        }}
                      >
                        {customer.name}
                      </button>
                      <p className="mt-0.5 hidden font-mono text-[9.5px] text-ink-300 sm:block">{customer.id}</p>
                    </td>
                    <td className="px-4 py-3 text-ink-600">{customer.email ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-ink-600">{customer.phone ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={customer.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[11px] text-ink-400">{formatDate(customer.created_at)}</td>
                    <td className="px-5 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${customer.name}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => view(customer)}>
                            <Eye className="size-3.5" />
                            View
                          </DropdownMenuItem>
                          {canManage && (
                            <>
                              <DropdownMenuItem onSelect={() => setEditing(customer)}>
                                <Pencil className="size-3.5" />
                                Edit
                              </DropdownMenuItem>
                              {customer.status === "archived" ? (
                                <DropdownMenuItem onSelect={() => void setStatus(customer, "active")}>
                                  <RotateCcw className="size-3.5" />
                                  Restore
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onSelect={() => void setStatus(customer, "archived")}>
                                  <Archive className="size-3.5" />
                                  Archive
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-coral focus:text-coral" onSelect={() => setRemoving(customer)}>
                                <Trash2 className="size-3.5" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
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

      <Sheet open={viewingId !== null} onOpenChange={(open) => !open && setViewingId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[520px]">
          <SheetHeader className="border-b border-border bg-card px-5 py-4">
            <div className="flex items-center gap-2">
              <StatusBadge status={detail?.status ?? viewing?.status ?? "active"} />
            </div>
            <SheetTitle className="mt-2 text-[17px] text-ink-950">{detail?.name ?? viewing?.name ?? "Customer"}</SheetTitle>
            <SheetDescription className="font-mono text-[10.5px] text-ink-400">{viewingId}</SheetDescription>
            {canManage && viewing && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="h-8 text-[11.5px]" onClick={() => setEditing(viewing)}>
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
                {viewing.status === "archived" ? (
                  <Button variant="outline" size="sm" className="h-8 text-[11.5px]" onClick={() => void setStatus(viewing, "active")}>
                    <RotateCcw className="size-3.5" />
                    Restore
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="h-8 text-[11.5px]" onClick={() => void setStatus(viewing, "archived")}>
                    <Archive className="size-3.5" />
                    Archive
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-8 border-coral/30 text-[11.5px] text-coral hover:bg-coral-soft" onClick={() => setRemoving(viewing)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              </div>
            )}
          </SheetHeader>
          <div className="space-y-4 p-5">
            {detailError ? (
              <p role="alert" className="text-[12px] text-destructive">
                {detailError}
              </p>
            ) : !detail ? (
              <p className="text-[12px] text-ink-400">Loading…</p>
            ) : (
              <>
                <section className="rounded-lg border border-border bg-card p-4">
                  <h3 className="text-[12px] font-semibold text-ink-900">Contact</h3>
                  <dl className="mt-2 grid grid-cols-[90px_1fr] gap-y-1.5 text-[12px]">
                    <dt className="text-ink-400">Email</dt>
                    <dd className="break-all text-ink-800">{detail.email ?? "—"}</dd>
                    <dt className="text-ink-400">Phone</dt>
                    <dd className="font-mono text-[11.5px] text-ink-800">{detail.phone ?? "—"}</dd>
                    <dt className="text-ink-400">Added</dt>
                    <dd className="text-ink-800">{formatDate(detail.created_at)}</dd>
                    {detail.updated_at && (
                      <>
                        <dt className="text-ink-400">Last edited</dt>
                        <dd className="text-ink-800">{formatDate(detail.updated_at)}</dd>
                      </>
                    )}
                  </dl>
                </section>
                <section className="rounded-lg border border-border bg-card">
                  <h3 className="border-b border-border px-4 py-2.5 text-[12px] font-semibold text-ink-900">
                    Accounts <span className="font-normal text-ink-400">({detail.accounts.length})</span>
                  </h3>
                  {detail.accounts.length === 0 ? (
                    <p className="px-4 py-3 text-[11.5px] text-ink-400">No accounts belong to this customer.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {detail.accounts.map((account) => (
                        <li key={account.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-[12px] text-ink-900">{account.label ?? `${account.currency} ${account.account_type}`}</p>
                            <p className="truncate font-mono text-[10px] text-ink-400">{account.id}</p>
                          </div>
                          <div className="text-right">
                            <p className="whitespace-nowrap font-mono text-[12px] text-ink-900">{formatMinor(account.balance_minor, account.currency)}</p>
                            <StatusBadge status={account.status} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="rounded-lg border border-border bg-card">
                  <h3 className="border-b border-border px-4 py-2.5 text-[12px] font-semibold text-ink-900">Payment requests</h3>
                  {detail.collection_totals.length === 0 ? (
                    <p className="px-4 py-3 text-[11.5px] text-ink-400">No payment requests yet.</p>
                  ) : (
                    <>
                      <ul className="grid grid-cols-2 gap-px bg-border">
                        {detail.collection_totals.map((total) => (
                          <li key={`${total.currency}-${total.status}`} className="bg-card px-4 py-2.5">
                            <p className="text-[10.5px] text-ink-400">
                              {statusLabel(total.status)} · {total.count}
                            </p>
                            <p className="font-mono text-[12.5px] text-ink-900">{formatMinor(total.amount_minor, total.currency)}</p>
                          </li>
                        ))}
                      </ul>
                      <ul className="divide-y divide-border border-t border-border">
                        {detail.recent_collections.map((item) => (
                          <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[11.5px]">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-ink-900">{item.reference}</p>
                              <p className="text-[10.5px] text-ink-400">{formatDate(item.created_at)}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="whitespace-nowrap font-mono text-ink-900">{formatMinor(item.amount, item.currency)}</span>
                              <StatusBadge status={item.status} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="Add a customer"
        description="Email must be unique within this workspace."
        submitLabel="Add customer"
        onSubmit={async () => {
          await api<Customer>("/customers", {
            method: "POST",
            body: JSON.stringify({ name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() })
          });
          toast.success(`${form.name.trim()} added.`);
          await load();
        }}
      >
        <Field id="customer-name" label="Name" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Field id="customer-email" label="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Field id="customer-phone" label="Phone (optional, international format)" type="tel" placeholder="+44 20 7946 0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </FormDialog>

      {editing && (
        <EditCustomerDialog
          customer={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            replace(updated);
            toast.success("Customer updated.");
          }}
        />
      )}

      <FormDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.name ?? "customer"}?`}
        description="A customer with no accounts or payment requests is deleted. One with history is archived instead, so the ledger keeps pointing at them; you can restore them later."
        submitLabel="Delete"
        destructive
        onSubmit={async () => {
          if (!removing) return;
          const result = await api<{ status: "deleted" | "archived"; message: string }>(
            `/customers/${encodeURIComponent(removing.id)}`,
            { method: "DELETE" }
          );
          if (result.status === "deleted") {
            setCustomers((current) => current.filter((item) => item.id !== removing.id));
            if (viewingId === removing.id) setViewingId(null);
          } else {
            replace({ id: removing.id, status: "archived" });
          }
          toast.success(result.message);
        }}
      >
        <p className="text-[12px] text-ink-600">This is recorded in the audit trail.</p>
      </FormDialog>
    </div>
  );
}

function EditCustomerDialog({
  customer,
  onClose,
  onSaved
}: {
  customer: Customer;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}) {
  const [form, setForm] = useState({ name: customer.name, email: customer.email ?? "", phone: customer.phone ?? "" });
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${customer.name}`}
      description="Leave email or phone empty to remove it."
      submitLabel="Save changes"
      onSubmit={async () => {
        const updated = await api<Customer>(`/customers/${encodeURIComponent(customer.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() })
        });
        onSaved(updated);
      }}
    >
      <Field id="edit-customer-name" label="Name" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <Field id="edit-customer-email" label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <Field id="edit-customer-phone" label="Phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
    </FormDialog>
  );
}
