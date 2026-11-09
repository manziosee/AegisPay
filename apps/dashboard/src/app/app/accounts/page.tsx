"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive as ArchiveIcon,
  BookOpen,
  Eye,
  MoreHorizontal,
  Pencil,
  Plus,
  Snowflake,
  Sun
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, apiIdempotent, errorMessage } from "@/lib/api";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { canFinance, isAdmin } from "@/lib/roles";
import { formatDate, formatDateTime, formatMinor, majorToMinor, minorHint } from "@/lib/format";
import type { Account, LedgerEntry, Page } from "@/lib/types";
import { cn } from "@/lib/utils";

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

export default function AccountsPage() {
  const { session, role } = useSession();
  const { data: workspace } = useWorkspaceData();
  const canManage = canFinance(role ?? undefined);
  // Simulated credits exist only in practice workspaces and are admin-only.
  const canCredit = isAdmin(role ?? undefined) && workspace.organization?.environment !== "live";
  const [crediting, setCrediting] = useState<Account | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [currency, setCurrency] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editing, setEditing] = useState<Account | null>(null);
  const [editForm, setEditForm] = useState({ label: "", status: "active" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [freezing, setFreezing] = useState<Account | null>(null);
  const [archiving, setArchiving] = useState<Account | null>(null);
  const [busyAccount, setBusyAccount] = useState("");

  const hydrate = useCallback(async (base: Account[]) => {
    const balances = await withConcurrency(base, 4, async (account) => {
      try {
        const result = await api<{ balance_minor: number }>(
          `/accounts/${encodeURIComponent(account.id)}/balance`
        );
        return { id: account.id, balance: result.balance_minor };
      } catch (error) {
        return { id: account.id, error: errorMessage(error) };
      }
    });
    return base.map((account) => {
      const result = balances.find((item) => item.id === account.id);
      if (result && "balance" in result) {
        return { ...account, balance_minor: result.balance };
      }
      return {
        ...account,
        balanceError: result && "error" in result ? result.error : "Balance unavailable"
      };
    });
  }, []);

  const load = useCallback(
    async (after?: string) => {
      if (!session) return;
      if (after) setLoadingMore(true);
      else setLoading(true);
      if (!after) setLoadError("");
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (after) query.set("cursor", after);
        const page = await api<Page<Account>>(`/accounts?${query.toString()}`);
        const hydrated = await hydrate(page.data ?? []);
        setAccounts((current) => (after ? [...current, ...hydrated] : hydrated));
        setCursor(page.has_more ? page.next_cursor : null);
        if (!after) {
          try {
            const entries = await api<{ data: LedgerEntry[] }>("/ledger/entries");
            setLedger(entries.data ?? []);
          } catch {
            setLedger([]);
          }
        }
      } catch (error) {
        if (after) toast.error(errorMessage(error));
        else setLoadError(errorMessage(error));
      } finally {
        if (after) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [hydrate, session]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const selected = accounts.find((item) => item.id === selectedId);
  const viewing = accounts.find((item) => item.id === viewingId) ?? null;
  const topCards = accounts.slice(0, 3);
  const filteredLedger = useMemo(
    () =>
      ledger.filter(
        (item) =>
          !selected || item.currency.trim().toUpperCase() === selected.currency.toUpperCase()
      ),
    [ledger, selected]
  );

  const openEdit = (account: Account) => {
    setEditForm({
      label: account.label ?? "",
      status: account.status === "frozen" ? "frozen" : "active"
    });
    setEditError("");
    setEditing(account);
  };

  const openCredit = (account: Account) => {
    setCreditAmount("");
    setCrediting(account);
  };

  const createAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      setCreateError("Currency must be a three-letter code.");
      return;
    }
    if (createLabel.trim().length > 80) {
      setCreateError("Label must be at most 80 characters.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      await api<Account>("/accounts", {
        method: "POST",
        body: JSON.stringify({
          currency: currency.trim().toUpperCase(),
          account_type: "wallet",
          label: createLabel.trim()
        })
      });
      toast.success(`Account created for ${currency.trim().toUpperCase()}.`);
      setCreateOpen(false);
      setCurrency("");
      setCreateLabel("");
      await load();
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const saveEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !editing) return;
    if (editForm.label.trim().length > 80) {
      setEditError("Label must be at most 80 characters.");
      return;
    }
    setSavingEdit(true);
    setEditError("");
    try {
      await api(`/accounts/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: editForm.label.trim(),
          status: editForm.status
        })
      });
      toast.success("Account label saved.");
      setEditing(null);
      await load();
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setSavingEdit(false);
    }
  };

  const changeStatus = async (account: Account, status: "active" | "frozen" | "archived") => {
    if (!session) return;
    setBusyAccount(account.id);
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}`, {
        method: status === "archived" ? "DELETE" : "PATCH",
        body:
          status === "archived"
            ? undefined
            : JSON.stringify({ status })
      });
      toast.success(
        status === "frozen"
          ? "Account frozen."
          : status === "active"
            ? "Account reactivated."
            : "Account archived."
      );
      setFreezing(null);
      setArchiving(null);
      if (status === "archived" && viewingId === account.id) setViewingId(null);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAccount("");
    }
  };

  const accountTitle = (account: Account) =>
    account.label?.trim() || `${account.currency} ${account.account_type.replaceAll("_", " ")}`;

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="Currency-specific ledger accounts and their postings. Balances are records built from journal lines, not funds held by AegisPay."
        actions={
          canManage ? (
            <Button
              className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" />
              Create account
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
          <Skeleton className="h-[220px] rounded-xl" />
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
      ) : loadError ? (
        <Panel>
          <EmptyState
            icon={BookOpen}
            title="Accounts could not be loaded"
            text={loadError}
            action={
              <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        </Panel>
      ) : accounts.length === 0 ? (
        <Panel>
          <EmptyState
            icon={BookOpen}
            title="No accounts yet"
            text={
              canManage
                ? "Create a currency account to record postings."
                : "No currency accounts have been created in this workspace."
            }
            action={
              canManage ? (
                <Button
                  className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                  onClick={() => setCreateOpen(true)}
                >
                  Create account
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <Panel>
              <PanelHeader
                title="Currency cards"
                description={`${accounts.length} account${accounts.length === 1 ? "" : "s"} loaded`}
              />
              <div className="px-5 pb-5 pt-5">
                <div className="relative h-[196px]">
                  {topCards
                    .slice()
                    .reverse()
                    .map((account, reverseIndex) => {
                      const index = topCards.length - 1 - reverseIndex;
                      const isTop = index === 0;
                      return (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => {
                            setSelectedId(account.id);
                            setViewingId(account.id);
                          }}
                          className={cn(
                            "absolute left-0 w-full max-w-[420px] rounded-xl border border-white/10 bg-ink-900 p-4 text-left text-on-night shadow-lift transition-transform",
                            isTop ? "top-0 z-30 hover:-translate-y-1" : "top-4 z-20"
                          )}
                          style={{
                            transform: isTop ? undefined : `translateY(${index * 12}px) scale(${1 - index * 0.03})`,
                            opacity: isTop ? 1 : 0.9
                          }}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted">
                                {account.currency.toUpperCase()}
                              </p>
                              <p className="mt-2 text-[24px] font-semibold leading-none tracking-[-0.03em]">
                                {account.balanceError
                                  ? "Balance unavailable"
                                  : account.balance_minor != null
                                    ? formatMinor(account.balance_minor, account.currency)
                                    : "Loading balance…"}
                              </p>
                            </div>
                            <span className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-on-night-muted">
                              {account.account_type}
                            </span>
                          </div>
                          <div className="mt-5 flex items-end justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-[11px] text-on-night">
                                {accountTitle(account)}
                              </p>
                              <p className="mt-1 font-mono text-[9.5px] text-on-night-muted/60">
                                {account.id}
                              </p>
                            </div>
                            <span className="size-6 shrink-0 rounded-full border border-mint/30 bg-mint/10" />
                          </div>
                        </button>
                      );
                    })}
                </div>
                <p className="mt-3 text-[10.5px] leading-relaxed text-ink-400">
                  {topCards.length < accounts.length
                    ? `Showing ${topCards.length} of ${accounts.length} loaded accounts. Select any row below.`
                    : "Select a card or table row to filter ledger entries."}
                </p>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Account comparison"
                description="Same dimensions, no combined total"
                action={
                  canManage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-[11.5px]"
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      Add account
                    </Button>
                  ) : undefined
                }
              />
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      {["Account", "Status", "Balance", "Created", ""].map((heading) => (
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
                    {accounts.map((account) => (
                      <tr
                        key={account.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(account.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(account.id);
                          }
                        }}
                        className={cn(
                          "cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50",
                          selectedId === account.id && "bg-primary-soft/40"
                        )}
                      >
                        <td className="px-5 py-3">
                          <p className="font-mono text-[11.5px] text-ink-900">
                            {account.currency}
                          </p>
                          <p className="mt-0.5 max-w-[180px] truncate text-[10.5px] text-ink-400">
                            {account.label?.trim() || account.account_type.replaceAll("_", " ")}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={account.status} />
                        </td>
                        <td className="px-4 py-3 font-mono text-[11.5px] text-ink-900">
                          {account.balanceError
                            ? "Unavailable"
                            : account.balance_minor != null
                              ? formatMinor(account.balance_minor, account.currency)
                              : "—"}
                        </td>
                        <td className="px-4 py-3 text-[11px] text-ink-400">
                          {formatDate(account.created_at)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Actions for ${accountTitle(account)}`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-48"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <DropdownMenuItem
                                onSelect={() => {
                                  setSelectedId(account.id);
                                  setViewingId(account.id);
                                }}
                              >
                                <Eye className="size-3.5" />
                                View details
                              </DropdownMenuItem>
                              {canCredit &&
                                account.account_type === "wallet" &&
                                account.status === "active" && (
                                  <DropdownMenuItem onSelect={() => openCredit(account)}>
                                    <Sun className="size-3.5" />
                                    Sandbox credit
                                  </DropdownMenuItem>
                                )}
                              {canManage && account.status !== "archived" && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onSelect={() => openEdit(account)}>
                                    <Pencil className="size-3.5" />
                                    Edit account
                                  </DropdownMenuItem>
                                  {account.status === "active" ? (
                                    <DropdownMenuItem onSelect={() => setFreezing(account)}>
                                      <Snowflake className="size-3.5" />
                                      Freeze account
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        void changeStatus(account, "active")
                                      }
                                      disabled={busyAccount === account.id}
                                    >
                                      <Sun className="size-3.5" />
                                      Reactivate account
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    variant="destructive"
                                    disabled={
                                      busyAccount === account.id ||
                                      account.balance_minor == null ||
                                      account.balance_minor !== 0
                                    }
                                    onSelect={() => setArchiving(account)}
                                  >
                                    <ArchiveIcon className="size-3.5" />
                                    Archive account
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
              {accounts.some((account) => account.balanceError) && (
                <p className="border-t border-border px-5 py-2.5 text-[10.5px] text-amber">
                  Some balances could not be loaded. They are shown as unavailable, not zero.
                </p>
              )}
              {cursor && (
                <div className="border-t border-border p-3 text-center">
                  <Button
                    variant="outline"
                    className="h-8 text-[11.5px]"
                    disabled={loadingMore}
                    onClick={() => void load(cursor)}
                  >
                    {loadingMore ? "Loading…" : "Load more accounts"}
                  </Button>
                </div>
              )}
            </Panel>
          </div>

          <Panel className="mt-4">
            <PanelHeader
              title="Ledger entries"
              description={
                selected
                  ? `${selected.currency} postings · latest 100 loaded`
                  : "Select an account to filter by currency · latest 100 loaded"
              }
              action={selected ? <StatusBadge status={selected.status} /> : undefined}
            />
            {filteredLedger.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No postings to show"
                text={
                  selected
                    ? `No journal entries for ${selected.currency} were returned by the ledger endpoint.`
                    : "Select an account, or record a transaction to create ledger postings."
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      {["Entry", "Reference type", "Reference", "Currency", "Amount", "Created"].map(
                        (heading) => (
                          <th
                            key={heading}
                            className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5"
                          >
                            {heading}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLedger.map((entry) => (
                      <tr key={entry.id} className="border-b border-border/70 text-[12px] last:border-0">
                        <td className="px-5 py-3 font-mono text-[10.5px] text-ink-400">{entry.id}</td>
                        <td className="px-4 py-3 capitalize text-ink-500">{entry.reference_type}</td>
                        <td className="px-4 py-3 font-mono text-[10.5px] text-ink-700">
                          {entry.reference_id}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px]">{entry.currency}</td>
                        <td className="px-4 py-3 font-mono text-[11.5px] text-ink-900">
                          {formatMinor(entry.amount, entry.currency)}
                        </td>
                        <td className="px-5 py-3 text-[11px] text-ink-400">
                          {formatDate(entry.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t border-border px-5 py-2.5 text-[10.5px] text-ink-400">
              Ledger entries are tenant-scoped journal records. No currency conversion is applied.
            </p>
          </Panel>
        </>
      )}

      <Sheet open={Boolean(viewing)} onOpenChange={(open) => !open && setViewingId(null)}>
        <SheetContent className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[480px]">
          {viewing && (
            <>
              <SheetHeader className="border-b border-border bg-card px-5 py-4">
                <div className="flex items-center gap-2">
                  <StatusBadge status={viewing.status} />
                  <span className="font-mono text-[10.5px] text-ink-400">{viewing.id}</span>
                </div>
                <SheetTitle className="mt-1 text-[16px] text-ink-950">
                  {accountTitle(viewing)}
                </SheetTitle>
                <SheetDescription className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-400">
                  {viewing.currency} · {viewing.account_type}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-5">
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-[10.5px] text-ink-400">Ledger balance</p>
                  <p className="mt-1 font-mono text-[24px] font-medium tracking-[-0.03em] text-ink-950">
                    {viewing.balanceError
                      ? "Unavailable"
                      : viewing.balance_minor != null
                        ? formatMinor(viewing.balance_minor, viewing.currency)
                        : "—"}
                  </p>
                  <p className="mt-1 text-[10.5px] text-ink-400">
                    Sum of journal lines. No currency conversion is applied.
                  </p>
                </div>
                <dl className="divide-y divide-border rounded-lg border border-border bg-card">
                  {[
                    ["Label", viewing.label?.trim() || "Not set"],
                    ["Account ID", viewing.id],
                    ["Currency", viewing.currency],
                    ["Type", viewing.account_type],
                    ["Customer", viewing.customer_id || "Wallet account"],
                    ["Created", formatDateTime(viewing.created_at)]
                  ].map(([label, value]) => (
                    <div key={label} className="px-4 py-3">
                      <dt className="text-[10.5px] text-ink-400">{label}</dt>
                      <dd className="mt-0.5 break-all font-mono text-[11px] text-ink-800">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-[10.5px] leading-relaxed text-ink-400">
                  Archiving is limited to a zero-balance account. Journal lines remain in the
                  ledger and the audit trail.
                </p>
              </div>
              <SheetFooter className="border-t border-border bg-card px-5 py-4">
                {canManage && viewing.status !== "archived" ? (
                  <div className="grid gap-2">
                    <Button
                      variant="outline"
                      className="h-9 text-[12px]"
                      onClick={() => {
                        openEdit(viewing);
                        setViewingId(null);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Edit account
                    </Button>
                    {viewing.status === "active" ? (
                      <Button
                        variant="outline"
                        className="h-9 text-[12px]"
                        onClick={() => {
                          setFreezing(viewing);
                          setViewingId(null);
                        }}
                      >
                        <Snowflake className="size-3.5" />
                        Freeze account
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="h-9 text-[12px]"
                        disabled={busyAccount === viewing.id}
                        onClick={() => void changeStatus(viewing, "active")}
                      >
                        <Sun className="size-3.5" />
                        Reactivate account
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="h-9 border-coral/30 text-[12px] text-coral hover:bg-coral-soft"
                      disabled={
                        busyAccount === viewing.id ||
                        viewing.balance_minor == null ||
                        viewing.balance_minor !== 0
                      }
                      onClick={() => {
                        setArchiving(viewing);
                        setViewingId(null);
                      }}
                    >
                      <ArchiveIcon className="size-3.5" />
                      Archive account
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-ink-400">
                    Read-only access. Finance roles can change account lifecycle.
                  </p>
                )}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">
              Edit {editing?.currency} account
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              Labels are presentation only. Freezing stops new postings to this account; existing
              journal lines are unchanged.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-label">Account label</Label>
              <Input
                id="account-label"
                value={editForm.label}
                onChange={(event) => setEditForm({ ...editForm, label: event.target.value })}
                maxLength={80}
                placeholder={`${editing?.currency ?? ""} wallet`}
                className="h-9 text-[12px]"
              />
              <p className="text-[10px] text-ink-400">Up to 80 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-status">Lifecycle status</Label>
              <select
                id="account-status"
                value={editForm.status}
                onChange={(event) => setEditForm({ ...editForm, status: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12px]"
              >
                <option value="active">Active</option>
                <option value="frozen">Frozen</option>
              </select>
            </div>
            {editError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {editError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-9 text-[12px]"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={savingEdit}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {savingEdit ? "Saving…" : "Save account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Create a currency account</DialogTitle>
            <DialogDescription className="text-[12px]">
              A wallet account is created with a zero ledger balance.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createAccount} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-currency">Currency code</Label>
              <Input
                id="account-currency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                required
                className="h-9 font-mono text-[12px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-label-new">Label (optional)</Label>
              <Input
                id="account-label-new"
                value={createLabel}
                onChange={(event) => setCreateLabel(event.target.value)}
                maxLength={80}
                placeholder="Operations wallet"
                className="h-9 text-[12px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-type">Account type</Label>
              <Input id="account-type" value="wallet" readOnly className="h-9 bg-paper-muted text-[12px]" />
            </div>
            {createError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creating}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {creating ? "Creating…" : "Create account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <FormDialog
        open={freezing !== null}
        onOpenChange={(next) => !next && setFreezing(null)}
        title="Freeze account?"
        description={
          freezing
            ? `${accountTitle(freezing)} (${freezing.id}) stops accepting new postings. Existing journal lines stay in the ledger.`
            : ""
        }
        destructive
        submitLabel="Freeze account"
        onSubmit={async () => {
          if (freezing) await changeStatus(freezing, "frozen");
        }}
      >
        <></>
      </FormDialog>

      <AlertDialog
        open={Boolean(archiving)}
        onOpenChange={(open) => !open && setArchiving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this account?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiving
                ? `${accountTitle(archiving)} (${archiving.id}) will be hidden from the account list. Only a zero-balance account can be archived; journal lines and audit records are retained.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busyAccount === archiving?.id}
              onClick={() => archiving && void changeStatus(archiving, "archived")}
            >
              {busyAccount === archiving?.id ? "Archiving…" : "Archive account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FormDialog
        open={crediting !== null}
        onOpenChange={(next) => !next && setCrediting(null)}
        title="Add a sandbox credit"
        description="Posts a simulated credit from the sandbox clearing account so you can test transfers and payouts. No real money is received."
        submitLabel="Post credit"
        onSubmit={async () => {
          if (!crediting) return;
          const amount = majorToMinor(creditAmount, crediting.currency);
          if (amount == null) throw new Error("Enter a positive amount.");
          await apiIdempotent(`/accounts/${encodeURIComponent(crediting.id)}/sandbox-credit`, { amount });
          toast.success(`${formatMinor(amount, crediting.currency)} credited.`);
          await load();
        }}
      >
        <Field
          id="credit-amount"
          label={`Amount (${crediting?.currency ?? ""})`}
          inputMode="decimal"
          required
          value={creditAmount}
          onChange={(event) => setCreditAmount(event.target.value)}
          hint={minorHint(creditAmount, crediting?.currency ?? "USD")}
        />
      </FormDialog>
    </div>
  );
}
