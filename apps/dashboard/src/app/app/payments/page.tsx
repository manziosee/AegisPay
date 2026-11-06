"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, HandCoins, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog, SelectField } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, apiIdempotent, errorMessage } from "@/lib/api";
import { formatDateTime, formatMinor, majorToMinor, minorHint } from "@/lib/format";
import { isAdmin } from "@/lib/roles";
import type { Account, Collection, Customer, Page, Transfer } from "@/lib/types";

type DialogState =
  | { kind: "collection" }
  | { kind: "confirm"; collection: Collection }
  | { kind: "refund"; collection: Collection }
  | { kind: "cancel"; collection: Collection }
  | { kind: "transfer" }
  | null;

function reference(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

function minorOrThrow(value: string, currency: string) {
  const minor = majorToMinor(value, currency);
  if (minor == null) throw new Error("Enter a positive amount.");
  return minor;
}

export default function PaymentsPage() {
  const { session, role } = useSession();
  const { refresh, data: workspace } = useWorkspaceData();
  const isLive = workspace.organization?.environment === "live";
  const [collections, setCollections] = useState<Collection[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadError, setLoadError] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const load = useCallback(async () => {
    if (!session) return;
    setLoadError("");
    // Each list loads independently so one failed request does not empty the others.
    const failures: string[] = [];
    const safe = async <T,>(label: string, path: string): Promise<Page<T> | null> => {
      try {
        return await api<Page<T>>(path);
      } catch (error) {
        failures.push(`${label}: ${errorMessage(error)}`);
        return null;
      }
    };
    const [collectionPage, transferPage, accountPage, customerPage] = await Promise.all([
      safe<Collection>("Collections", "/collections?limit=100"),
      safe<Transfer>("Transfers", "/transfers?limit=100"),
      safe<Account>("Accounts", "/accounts?limit=100"),
      safe<Customer>("Customers", "/customers?limit=100")
    ]);
    if (collectionPage) setCollections(collectionPage.data);
    if (transferPage) setTransfers(transferPage.data);
    if (accountPage) setAccounts(accountPage.data.filter((account) => account.account_type !== "sandbox_clearing"));
    if (customerPage) setCustomers(customerPage.data);
    if (failures.length) setLoadError(`Some data could not be loaded. ${failures.join(" · ")}`);
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (next: DialogState, defaults: Record<string, string> = {}) => {
    setForm(defaults);
    setDialog(next);
  };

  const after = async (message: string) => {
    toast.success(message);
    await Promise.all([load(), refresh()]);
  };

  const accountOptions = (currency?: string) =>
    accounts
      .filter((account) => !currency || account.currency.trim().toUpperCase() === currency.trim().toUpperCase())
      .map((account) => ({ value: account.id, label: `${account.currency} · ${account.id}` }));

  const submit = async () => {
    if (!dialog) return;
    switch (dialog.kind) {
      case "collection": {
        const currency = (form.currency ?? "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter ISO 4217 code.");
        const result = await apiIdempotent<Collection>("/collections", {
          amount: minorOrThrow(form.amount ?? "", currency),
          currency,
          reference: (form.reference ?? "").trim(),
          description: (form.description ?? "").trim(),
          customer_id: form.customer || undefined
        });
        await after(`Collection ${result.reference} created. Confirm it once the payment is received.`);
        break;
      }
      case "confirm":
        if (!form.account) throw new Error("Choose the account to credit.");
        await apiIdempotent(`/collections/${encodeURIComponent(dialog.collection.id)}/sandbox-confirm`, {
          account_id: form.account
        });
        await after("Collection confirmed and posted to the ledger.");
        break;
      case "refund":
        await apiIdempotent(`/collections/${encodeURIComponent(dialog.collection.id)}/refunds`, {
          amount: minorOrThrow(form.amount ?? "", dialog.collection.currency),
          reference: (form.reference ?? "").trim()
        });
        await after("Refund posted.");
        break;
      case "cancel":
        await api(`/collections/${encodeURIComponent(dialog.collection.id)}/cancel`, { method: "POST", body: "{}" });
        await after("Collection cancelled.");
        break;
      case "transfer": {
        const source = accounts.find((account) => account.id === form.source);
        if (!source || !form.destination) throw new Error("Choose a source and destination account.");
        const result = await apiIdempotent<Transfer>("/transfers", {
          source_account_id: source.id,
          destination_account_id: form.destination,
          amount: minorOrThrow(form.amount ?? "", source.currency),
          currency: source.currency.trim().toUpperCase(),
          reference: (form.reference ?? "").trim()
        });
        await after(
          result.status === "pending_approval"
            ? "Transfer created. It is above the approval threshold, so a second reviewer must approve it."
            : "Transfer completed."
        );
        break;
      }
    }
  };

  const sourceCurrency = accounts.find((account) => account.id === form.source)?.currency;
  const dialogTitle: Record<NonNullable<DialogState>["kind"], string> = {
    collection: "Create a collection",
    confirm: "Confirm a collection",
    refund: "Refund a collection",
    cancel: "Cancel a collection",
    transfer: "Transfer between accounts"
  };

  return (
    <div>
      <PageHeader
        title="Collections and transfers"
        description={
          isLive
            ? "Record money you expect to receive and move funds between your accounts. A collection is confirmed when a line in your imported bank statement matches its reference and amount."
            : "Practice workspace: record money you expect, confirm it with simulated money, refund it, or move funds between accounts."
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-9 text-[12.5px]"
              onClick={() => open({ kind: "transfer" }, { reference: reference("TRF") })}
            >
              <ArrowLeftRight className="size-3.5" />
              New transfer
            </Button>
            <Button
              className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
              onClick={() => open({ kind: "collection" }, { currency: accounts[0]?.currency ?? "", reference: reference("COL") })}
            >
              <Plus className="size-3.5" />
              New collection
            </Button>
          </div>
        }
      />

      {loadError && (
        <p role="alert" className="mb-4 rounded-md border border-coral/20 bg-coral-soft px-3 py-2 text-[12px] text-[#a83422]">
          {loadError}
        </p>
      )}

      <Tabs defaultValue="collections">
        <TabsList>
          <TabsTrigger value="collections">Collections ({collections.length})</TabsTrigger>
          <TabsTrigger value="transfers">Transfers ({transfers.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="collections">
          <Panel>
            <PanelHeader title="Collections" description="Latest 100" />
            {collections.length === 0 ? (
              <EmptyState icon={HandCoins} title="No collections yet" text="Create a collection for a payment you expect to receive." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      {["Reference", "Amount", "Status", "Created", ""].map((heading) => (
                        <th key={heading} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {collections.map((item) => (
                      <tr key={item.id} className="border-b border-border/70 text-[12px] last:border-0">
                        <td className="px-5 py-3">
                          <p className="font-mono text-[11.5px] text-ink-900">{item.reference}</p>
                          <p className="text-[10.5px] text-ink-400">{item.description || item.id}</p>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11.5px]">{formatMinor(item.amount, item.currency)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="px-4 py-3 text-[11px] text-ink-400">{formatDateTime(item.created_at)}</td>
                        <td className="px-5 py-3 text-right">
                          {item.status === "pending" && (
                            <span className="inline-flex items-center gap-1.5">
                              {isLive ? (
                                <span className="text-[10.5px] text-ink-400">Awaiting bank statement</span>
                              ) : (
                                <Button size="sm" className="h-7 text-[11px]" onClick={() => open({ kind: "confirm", collection: item }, { account: accountOptions(item.currency)[0]?.value ?? "" })}>
                                  Confirm
                                </Button>
                              )}
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => open({ kind: "cancel", collection: item })}>
                                Cancel
                              </Button>
                            </span>
                          )}
                          {item.status === "succeeded" && (
                            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => open({ kind: "refund", collection: item }, { reference: reference("RFD") })}>
                              Refund
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="transfers">
          <Panel>
            <PanelHeader title="Transfers" description="Latest 100 · approvals happen on the Approvals page" />
            {transfers.length === 0 ? (
              <EmptyState icon={ArrowLeftRight} title="No transfers yet" text="Move funds between two accounts in the same currency." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-paper-muted/60">
                      {["Reference", "Amount", "Status", "Approvals", "Created"].map((heading) => (
                        <th key={heading} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {transfers.map((item) => (
                      <tr key={item.id} className="border-b border-border/70 text-[12px] last:border-0">
                        <td className="px-5 py-3 font-mono text-[11.5px] text-ink-900">{item.reference}</td>
                        <td className="px-4 py-3 font-mono text-[11.5px]">{formatMinor(item.amount, item.currency)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-ink-500">
                          {item.approvals_received ?? 0}/{item.required_approvals ?? 1}
                        </td>
                        <td className="px-5 py-3 text-[11px] text-ink-400">{formatDateTime(item.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </TabsContent>
      </Tabs>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(next) => !next && setDialog(null)}
        title={dialog ? dialogTitle[dialog.kind] : ""}
        destructive={dialog?.kind === "cancel" || dialog?.kind === "refund"}
        submitLabel={
          dialog?.kind === "confirm"
            ? "Confirm and post"
            : dialog?.kind === "cancel"
              ? "Cancel collection"
              : dialog?.kind === "refund"
                ? isLive ? "Record refund" : "Post refund"
                : dialog?.kind === "transfer"
                  ? "Transfer"
                  : "Create collection"
        }
        description={
          dialog?.kind === "confirm"
            ? `${formatMinor(dialog.collection.amount, dialog.collection.currency)} · ${dialog.collection.reference}. Practice only: confirms the collection with simulated money.`
            : dialog?.kind === "refund"
              ? `Up to ${formatMinor(dialog.collection.amount, dialog.collection.currency)} less earlier refunds.${isLive ? " This records the refund in your ledger; make the payment itself at your bank or provider." : ""}`
              : dialog?.kind === "cancel"
                ? `${dialog.collection.reference} will no longer be matched or confirmed.`
                : dialog?.kind === "transfer"
                  ? "Both accounts must use the same currency. Transfers at or above your approval threshold wait for a second reviewer."
                  : "Use a reference your payer will quote; reconciliation matches statement lines by it."
        }
        onSubmit={submit}
      >
        {dialog?.kind === "collection" && (
          <>
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field id="col-amount" label="Amount" inputMode="decimal" required value={form.amount ?? ""} onChange={set("amount")} hint={minorHint(form.amount ?? "", form.currency ?? "USD")} />
              <Field id="col-currency" label="Currency" required maxLength={3} className="h-9 font-mono text-[12px]" value={form.currency ?? ""} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            </div>
            <Field id="col-reference" label="Reference" required value={form.reference ?? ""} onChange={set("reference")} />
            <Field id="col-description" label="Description (optional)" value={form.description ?? ""} onChange={set("description")} />
            <SelectField id="col-customer" label="Customer (optional)" value={form.customer ?? ""} onChange={(value) => setForm({ ...form, customer: value })} options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          </>
        )}
        {dialog?.kind === "confirm" && (
          <SelectField id="confirm-account" label={`Credit account (${dialog.collection.currency})`} required value={form.account ?? ""} onChange={(value) => setForm({ ...form, account: value })} options={accountOptions(dialog.collection.currency)} />
        )}
        {dialog?.kind === "refund" && (
          <>
            <Field id="refund-amount" label={`Amount (${dialog.collection.currency})`} inputMode="decimal" required value={form.amount ?? ""} onChange={set("amount")} />
            <Field id="refund-reference" label="Refund reference" required value={form.reference ?? ""} onChange={set("reference")} />
          </>
        )}
        {dialog?.kind === "transfer" && (
          <>
            <SelectField id="trf-source" label="From account" required value={form.source ?? ""} onChange={(value) => setForm({ ...form, source: value, destination: "" })} options={accountOptions()} />
            <SelectField id="trf-destination" label="To account" required value={form.destination ?? ""} onChange={(value) => setForm({ ...form, destination: value })} options={accountOptions(sourceCurrency).filter((option) => option.value !== form.source)} />
            <Field id="trf-amount" label={`Amount${sourceCurrency ? ` (${sourceCurrency})` : ""}`} inputMode="decimal" required value={form.amount ?? ""} onChange={set("amount")} />
            <Field id="trf-reference" label="Reference" required value={form.reference ?? ""} onChange={set("reference")} />
          </>
        )}
      </FormDialog>
      {!isAdmin(role ?? undefined) && (
        <p className="mt-3 text-[10.5px] text-ink-400">Refunds require a role with refund permission.</p>
      )}
    </div>
  );
}
