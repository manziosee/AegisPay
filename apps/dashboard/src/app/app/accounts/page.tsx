"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, apiIdempotent, errorMessage } from "@/lib/api";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { isAdmin } from "@/lib/roles";
import { formatDate, formatMinor, majorToMinor, minorHint } from "@/lib/format";
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
  // Simulated credits exist only in practice workspaces.
  const canCredit = isAdmin(role ?? undefined) && workspace.organization?.environment !== "live";
  const [crediting, setCrediting] = useState<Account | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [currency, setCurrency] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      const page = await api<Page<Account>>("/accounts?limit=25");
      const base = page.data ?? [];
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
      setAccounts(
        base.map((account) => {
          const result = balances.find((item) => item.id === account.id);
          if (result && "balance" in result) {
            return { ...account, balance_minor: result.balance };
          }
          return {
            ...account,
            balanceError: result && "error" in result ? result.error : "Balance unavailable"
          };
        })
      );
      try {
        const entries = await api<{ data: LedgerEntry[] }>(
          "/ledger/entries"
        );
        setLedger(entries.data ?? []);
      } catch {
        setLedger([]);
      }
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = accounts.find((item) => item.id === selectedId);
  const topCards = accounts.slice(0, 3);
  const filteredLedger = useMemo(
    () =>
      ledger.filter(
        (item) =>
          !selected || item.currency.trim().toUpperCase() === selected.currency.toUpperCase()
      ),
    [ledger, selected]
  );

  const createAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      setCreateError("Currency must be a three-letter code.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      await api<Account>("/accounts", {
        method: "POST",
        body: JSON.stringify({ currency: currency.trim().toUpperCase(), account_type: "wallet" })
      });
      toast.success(`Account created for ${currency.trim().toUpperCase()}.`);
      setCreateOpen(false);
      await load();
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="Currency-specific ledger accounts and their postings. Balances are records built from journal lines, not funds held by AegisPay."
        actions={
          <Button
            className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            Create account
          </Button>
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
            text="Create a currency account to record postings."
            action={
              <Button
                className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                onClick={() => setCreateOpen(true)}
              >
                Create account
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <Panel>
              <PanelHeader
                title="Currency cards"
                description={`${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
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
                          onClick={() => setSelectedId(account.id)}
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
                            <div>
                              <p className="font-mono text-[9.5px] text-on-night-muted/60">
                                {account.id}
                              </p>
                              <p className="mt-1 text-[10.5px] capitalize text-on-night-muted">
                                {account.status}
                              </p>
                            </div>
                            <span className="size-6 rounded-full border border-mint/30 bg-mint/10" />
                          </div>
                        </button>
                      );
                    })}
                </div>
                <p className="mt-3 text-[10.5px] leading-relaxed text-ink-400">
                  {topCards.length < accounts.length
                    ? `Showing ${topCards.length} of ${accounts.length} accounts. Select any row below.`
                    : "Select a card or table row to filter ledger entries."}
                </p>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Account comparison"
                description="Same dimensions, no combined total"
              />
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      {["Currency", "Type", "Status", "Balance", "Created", ""].map((heading) => (
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
                        <td className="px-5 py-3 font-mono text-[11.5px] text-ink-900">
                          {account.currency}
                        </td>
                        <td className="px-4 py-3 capitalize text-ink-500">{account.account_type}</td>
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
                        <td className="px-5 py-3 text-[11px] text-ink-400">
                          {formatDate(account.created_at)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {canCredit && account.account_type === "wallet" && account.status === "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px]"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCreditAmount("");
                                setCrediting(account);
                              }}
                            >
                              Sandbox credit
                            </Button>
                          )}
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
    </div>
  );
}
