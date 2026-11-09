"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  FileUp,
  Landmark,
  Link2,
  Loader2,
  Search,
  SkipForward,
  Sparkles,
  Upload
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { FormDialog, SelectField } from "@/components/ui-blocks/form-dialog";
import { api, apiIdempotent, errorMessage } from "@/lib/api";
import { formatDate, formatMinor } from "@/lib/format";
import type { Collection, Page, ReconciliationLine, ReconciliationSource } from "@/lib/types";
import { cn } from "@/lib/utils";

type LineAction = { line: ReconciliationLine; resolution: "match" | "ignore" };

const providerLabel: Record<string, string> = {
  bank: "Bank",
  stripe: "Stripe",
  mpesa: "M-Pesa",
  flutterwave: "Flutterwave"
};

type ProviderImportResult = {
  id: string;
  provider: string;
  line_count: number;
  matched_count: number;
  exception_count: number;
  suggested_count: number;
  skipped_rows: number;
};

export default function ReconciliationPage() {
  const { session } = useSession();
  const { data, refresh, loading } = useWorkspaceData();
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const [lines, setLines] = useState<ReconciliationLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [action, setAction] = useState<LineAction | null>(null);
  const [note, setNote] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionsError, setCollectionsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [sources, setSources] = useState<ReconciliationSource[]>([]);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerForm, setProviderForm] = useState({ provider: "auto", fileName: "", csv: "" });

  const loadSources = useCallback(async () => {
    try {
      const result = await api<{ data: ReconciliationSource[] }>("/reconciliation/sources");
      setSources(result.data);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    if (session) void loadSources();
  }, [session, loadSources]);

  const selectedImport = data.imports.find((item) => item.id === selectedImportId);
  const exceptions = lines.filter(
    (line) => !["matched", "ignored"].includes(line.match_status)
  );

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("import");
    if (id) setSelectedImportId(id);
  }, []);

  useEffect(() => {
    if (!selectedImportId || !session) return;
    let active = true;
    setLinesLoading(true);
    void api<{ lines: ReconciliationLine[] }>(
      `/reconciliation/imports/${encodeURIComponent(selectedImportId)}`
    )
      .then((detail) => {
        if (active) setLines(detail.lines ?? []);
      })
      .catch((error) => {
        if (active) {
          setLines([]);
          toast.error(errorMessage(error));
        }
      })
      .finally(() => {
        if (active) setLinesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedImportId, session]);

  useEffect(() => {
    if (!action || !session) return;
    let active = true;
    setCollections([]);
    setCollectionsError("");
    setCollectionsLoading(true);
    void api<Page<Collection>>("/collections?limit=100")
      .then((page) => {
        if (active) setCollections(page.data ?? []);
      })
      .catch((error) => {
        if (active) setCollectionsError(errorMessage(error));
      })
      .finally(() => {
        if (active) setCollectionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [action, session]);

  const openAction = (line: ReconciliationLine, resolution: "match" | "ignore", suggested = false) => {
    setAction({ line, resolution });
    setNote(suggested ? "Accepted the suggested match after checking it is the same payment." : "");
    setCollectionId(suggested ? line.suggested_collection_id ?? "" : "");
    setCollectionQuery("");
    setDialogError("");
  };

  const visibleCollections = useMemo(() => {
    if (!action) return [];
    const needle = collectionQuery.trim().toLowerCase();
    return collections
      .filter((item) => {
        if (!needle) return true;
        return `${item.reference} ${item.id}`.toLowerCase().includes(needle);
      })
      .slice(0, 12);
  }, [action, collections, collectionQuery]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !action || !selectedImportId) return;
    if (!note.trim()) {
      setDialogError("Add a resolution note before continuing.");
      return;
    }
    if (action.resolution === "match" && !collectionId.trim()) {
      setDialogError("Choose a matching collection or enter its collection ID.");
      return;
    }
    setSaving(true);
    setDialogError("");
    try {
      await api(`/reconciliation/imports/${encodeURIComponent(selectedImportId)}/lines/${action.line.line_id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          resolution: action.resolution,
          collection_id: action.resolution === "match" ? collectionId.trim() : "",
          note: note.trim()
        })
      });
      toast.success("Reconciliation exception resolved.");
      setAction(null);
      await Promise.all([
        refresh(),
        loadSources(),
        selectedImportId
          ? api<{ lines: ReconciliationLine[] }>(
              `/reconciliation/imports/${encodeURIComponent(selectedImportId)}`
            ).then((detail) => setLines(detail.lines ?? []))
          : Promise.resolve()
      ]);
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Reconciliation"
        description="Review imported statement lines, compare them with ledger collections and resolve each exception with evidence."
        actions={
          <>
            <Button asChild variant="outline" className="h-9 border-border bg-card text-[12.5px]">
              <Link href="/app/money#statement">
                <FileUp className="size-3.5" />
                Import a bank statement
              </Link>
            </Button>
            <Button
              className="h-9 bg-primary text-[12.5px] font-semibold text-primary-foreground"
              onClick={() => {
                setProviderForm({ provider: "auto", fileName: "", csv: "" });
                setProviderOpen(true);
              }}
            >
              <Upload className="size-3.5" />
              Import Stripe, M-Pesa or Flutterwave
            </Button>
          </>
        }
      />

      {sources.length > 0 && (
        <section aria-label="Statement sources" className="mb-4">
          <h2 className="mb-2 text-[12px] font-semibold text-ink-900">Every source, side by side</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {sources.map((source) => {
              const share = source.line_count ? Math.round((source.matched_count / source.line_count) * 100) : 0;
              return (
                <li key={`${source.provider}-${source.currency}`} className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[12.5px] font-semibold text-ink-900">
                      {providerLabel[source.provider] ?? source.provider} <span className="font-mono text-[11px] font-normal text-ink-400">{source.currency}</span>
                    </p>
                    <p className="text-[10.5px] text-ink-400">{formatDate(source.last_import_at)}</p>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-500">
                    {source.matched_count} of {source.line_count} lines matched · {share}%
                  </p>
                  <div
                    className="mt-1.5 h-1.5 rounded-full bg-primary-soft"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={share}
                    aria-label={`${providerLabel[source.provider] ?? source.provider} ${source.currency} matched`}
                  >
                    <div className="h-1.5 rounded-full bg-primary" style={{ width: `${share}%` }} />
                  </div>
                  <dl className="mt-2.5 grid grid-cols-2 gap-x-2 text-[10.5px]">
                    <dt className="text-ink-400">Still open</dt>
                    <dd className="text-right font-mono text-ink-800">{formatMinor(source.open_amount, source.currency)}</dd>
                    <dt className="text-ink-400">Provider fees</dt>
                    <dd className="text-right font-mono text-ink-800">{formatMinor(source.provider_fees, source.currency)}</dd>
                  </dl>
                  {source.suggested_count > 0 && (
                    <p className="mt-2 flex items-center gap-1 text-[10.5px] text-ink-600">
                      <Sparkles className="size-3 text-primary" aria-hidden />
                      {source.suggested_count} suggested {source.suggested_count === 1 ? "match" : "matches"} to review
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[0.78fr_1.42fr]">
        <Panel className="min-h-[360px]">
          <PanelHeader
            title="Statement imports"
            description={`${data.imports.length} recent import${data.imports.length === 1 ? "" : "s"}`}
          />
          {loading && data.imports.length === 0 ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-12 animate-pulse rounded-md bg-paper-muted" />
              ))}
            </div>
          ) : data.imports.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No statement imports"
              text="Imports created through the reconciliation API will show up here."
              action={
                <Button asChild variant="outline" className="h-8 text-[11.5px]">
                  <Link href="/app/money#statement">Import a CSV</Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.imports.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedImportId(item.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                      selectedImportId === item.id
                        ? "bg-primary-soft/50"
                        : "hover:bg-paper-muted/60"
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-md border",
                        selectedImportId === item.id
                          ? "border-primary/20 bg-card text-primary"
                          : "border-border bg-paper text-ink-400"
                      )}
                    >
                      <Landmark className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink-900">
                        {item.provider && item.provider !== "bank" && (
                          <span className="mr-1.5 rounded border border-border bg-paper-muted px-1 py-px text-[10px] font-normal text-ink-500">
                            {providerLabel[item.provider] ?? item.provider}
                          </span>
                        )}
                        {item.source_name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-400">
                        {item.id} · {formatDate(item.created_at)}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <StatusBadge status={item.status} />
                      {item.exception_count > 0 ? (
                        <span className="rounded bg-amber-soft px-1.5 py-0.5 font-mono text-[10px] text-amber">
                          {item.exception_count}
                        </span>
                      ) : (
                        <Check className="size-3.5 text-mint" />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="min-h-[420px]">
          <PanelHeader
            title={selectedImport ? "Import exceptions" : "Select an import"}
            description={
              selectedImport
                ? `${selectedImport.line_count} lines · ${selectedImport.matched_count} matched · ${selectedImport.exception_count} need attention`
                : "Choose an import to inspect matching results."
            }
            action={selectedImport ? <StatusBadge status={selectedImport.status} /> : undefined}
          />

          {linesLoading ? (
            <div className="flex min-h-[260px] items-center justify-center gap-2 text-[12px] text-ink-400">
              <Loader2 className="size-4 animate-spin" />
              Loading statement lines…
            </div>
          ) : !selectedImportId ? (
            <EmptyState
              icon={Landmark}
              title="No import selected"
              text="Select a statement import on the left to inspect its lines."
            />
          ) : exceptions.length === 0 ? (
            <EmptyState
              icon={Check}
              title="All lines resolved"
              text="This import has no remaining reconciliation exceptions."
            />
          ) : (
            <div className="divide-y divide-border">
              {exceptions.map((line) => (
                <article key={line.line_id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[12px] text-ink-900">
                        {line.external_reference}
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-400">
                        {formatDate(line.transaction_date)} · line {line.line_id}
                      </p>
                    </div>
                    <StatusBadge status={line.match_status} />
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-border bg-paper px-3 py-2.5">
                    {[
                      ["Net amount", formatMinor(line.amount, line.currency)],
                      ["Provider fee", formatMinor(line.provider_fee, line.currency)],
                      ["Gross amount", formatMinor(line.gross_amount, line.currency)]
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="text-[10px] text-ink-400">{label}</p>
                        <p className="mt-0.5 font-mono text-[11.5px] text-ink-800">{value}</p>
                      </div>
                    ))}
                  </div>

                  {line.suggestion_reason && (
                    <p
                      className={cn(
                        "mt-3 rounded-md border-l-2 px-3 py-2 text-[11px] leading-relaxed",
                        line.suggested_collection_id
                          ? "border-primary bg-primary-soft/60 text-ink-800"
                          : "border-amber bg-amber-soft/60 text-[#7a5210]"
                      )}
                    >
                      {line.suggested_collection_id && <Sparkles className="mr-1 inline size-3 text-primary" aria-hidden />}
                      {line.suggestion_reason}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="h-8 text-[11.5px]"
                      onClick={() => openAction(line, "ignore")}
                    >
                      <SkipForward className="size-3.5" />
                      Ignore with note
                    </Button>
                    {line.match_status !== "duplicate" && line.suggested_collection_id && (
                      <Button
                        className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
                        onClick={() => openAction(line, "match", true)}
                      >
                        <Sparkles className="size-3.5" />
                        Review suggested match
                      </Button>
                    )}
                    {line.match_status !== "duplicate" && (
                      <Button
                        variant={line.suggested_collection_id ? "outline" : "default"}
                        className={cn(
                          "h-8 text-[11.5px]",
                          !line.suggested_collection_id && "bg-primary font-semibold text-primary-foreground"
                        )}
                        onClick={() => openAction(line, "match")}
                      >
                        <Link2 className="size-3.5" />
                        Link collection
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="border-t border-border px-4 py-2.5">
            <p className="text-[10.5px] leading-relaxed text-ink-400">
              Matching compares reference, currency and gross collection amount. When a reference
              matches nothing, AegisPay suggests a likely request and says why; nothing is matched
              until you accept it. The resolution note is stored with the audit event.
            </p>
          </div>
        </Panel>
      </div>

      <Dialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        <DialogContent className="max-h-[90vh] w-full overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">
              {action?.resolution === "ignore" ? "Ignore statement line" : "Match statement line"}
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              {action ? (
                <>
                  {action.line.external_reference} ·{" "}
                  {formatMinor(action.line.gross_amount, action.line.currency)} gross
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-4">
            {action?.resolution === "match" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="collection-search">Search collections</Label>
                  <span className="text-[10.5px] text-ink-400">
                    {collectionsLoading ? "Loading…" : `${collections.length} loaded`}
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
                  <Input
                    id="collection-search"
                    value={collectionQuery}
                    onChange={(event) => setCollectionQuery(event.target.value)}
                    placeholder="Search by reference or collection ID"
                    className="h-9 pl-9 text-[12px]"
                  />
                </div>

                {collectionsError ? (
                  <p className="rounded-md border border-amber/20 bg-amber-soft/60 px-3 py-2 text-[11px] text-[#7a5210]">
                    Collection search is unavailable ({collectionsError}). Enter the collection ID
                    manually below.
                  </p>
                ) : (
                  <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border">
                    {visibleCollections.length === 0 ? (
                      <p className="px-3 py-4 text-[11.5px] text-ink-400">
                        {collectionsLoading ? "Loading collections…" : "No collections match."}
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {visibleCollections.map((collection) => {
                          const amountMatches =
                            collection.amount === action.line.gross_amount &&
                            collection.currency.toUpperCase() ===
                              action.line.currency.toUpperCase();
                          const succeeded = collection.status === "succeeded";
                          const disabled = !amountMatches || !succeeded;
                          const reason = !succeeded
                            ? "Collection is not succeeded"
                            : !amountMatches
                              ? "Amount or currency differs from gross amount"
                              : "";
                          return (
                            <li key={collection.id}>
                              <button
                                type="button"
                                disabled={!amountMatches || !succeeded}
                                onClick={() => setCollectionId(collection.id)}
                                className={cn(
                                  "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left",
                                  collectionId === collection.id && "bg-primary-soft/50",
                                  disabled
                                    ? "cursor-not-allowed opacity-60"
                                    : "hover:bg-paper-muted/60"
                                )}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-mono text-[11.5px] text-ink-900">
                                    {collection.reference}
                                  </span>
                                  <span className="block truncate font-mono text-[9.5px] text-ink-400">
                                    {collection.id}
                                  </span>
                                  {disabled && (
                                    <span className="mt-0.5 block text-[10px] text-amber">
                                      {reason}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className="block font-mono text-[11px] text-ink-800">
                                    {formatMinor(collection.amount, collection.currency)}
                                  </span>
                                  <StatusBadge status={collection.status} />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

            {action?.resolution === "match" && (
              <div className="space-y-2">
                <Label htmlFor="collection-id">Collection ID</Label>
                <Input
                  id="collection-id"
                  value={collectionId}
                  onChange={(event) => setCollectionId(event.target.value)}
                  placeholder="col_…"
                  required
                  className="h-9 font-mono text-[12px]"
                />
                <p className="text-[10.5px] text-ink-400">
                  Selecting a candidate fills this value. Manual entry remains available.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="resolution-note">Resolution note</Label>
              <Textarea
                id="resolution-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                required
                placeholder="Explain why this line is being resolved…"
                className="min-h-[80px] text-[12px]"
              />
            </div>

            {dialogError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {dialogError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setAction(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {saving ? "Saving…" : "Confirm resolution"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <FormDialog
        open={providerOpen}
        onOpenChange={setProviderOpen}
        title="Import a payment-provider export"
        description="Upload the CSV you export from the provider's dashboard. Completed incoming payments are matched like bank statement lines; payouts to your bank, charges and failed attempts are skipped."
        submitLabel="Import and match"
        onSubmit={async () => {
          if (!providerForm.csv) throw new Error("Choose a CSV file first.");
          const result = await apiIdempotent<ProviderImportResult>("/reconciliation/imports/provider", {
            provider: providerForm.provider,
            source_name: providerForm.fileName,
            csv: providerForm.csv
          });
          const parts = [
            `${result.matched_count} matched`,
            `${result.exception_count} need attention`,
            result.suggested_count ? `${result.suggested_count} with a suggested match` : "",
            result.skipped_rows ? `${result.skipped_rows} rows skipped` : ""
          ].filter(Boolean);
          toast.success(`${providerLabel[result.provider] ?? result.provider}: ${result.line_count} payments imported. ${parts.join(", ")}.`);
          await Promise.all([refresh(), loadSources()]);
          setSelectedImportId(result.id);
        }}
      >
        <SelectField
          id="provider"
          label="Provider"
          value={providerForm.provider}
          onChange={(value) => setProviderForm({ ...providerForm, provider: value })}
          options={[
            { value: "auto", label: "Detect from the file" },
            { value: "stripe", label: "Stripe (balance history or itemized balance report)" },
            { value: "mpesa", label: "M-Pesa (business statement)" },
            { value: "flutterwave", label: "Flutterwave (transactions export)" }
          ]}
        />
        <div className="space-y-2">
          <Label htmlFor="provider-file">CSV file</Label>
          <Input
            id="provider-file"
            type="file"
            accept=".csv,text/csv"
            className="h-9 text-[12px]"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 2 * 1024 * 1024) {
                toast.error("The file is larger than 2 MB. Export a shorter date range.");
                return;
              }
              setProviderForm({ ...providerForm, fileName: file.name, csv: await file.text() });
            }}
          />
          <p className="text-[10.5px] text-ink-400">
            The payment reference you gave the customer must appear in the export: Stripe description or metadata, the M-Pesa account
            number, or the Flutterwave tx_ref.
          </p>
        </div>
      </FormDialog>

      {data.imports.length > 0 && selectedImportId && (
        <div className="mt-3 flex justify-end">
          <Link
            href="/app/intelligence"
            className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-400 hover:text-ink-700"
          >
            Review a risk case instead
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}
