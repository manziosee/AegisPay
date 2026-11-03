"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Page, WebhookDelivery, WebhookEndpoint } from "@/lib/types";

export default function WebhooksPage() {
  const { session } = useSession();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [deliveryPage, endpointResult] = await Promise.all([
        api<Page<WebhookDelivery>>("/webhook-deliveries?limit=25"),
        api<{ data: WebhookEndpoint[] }>("/webhook-endpoints")
      ]);
      setDeliveries(deliveryPage.data ?? []);
      setCursor(deliveryPage.next_cursor ?? null);
      setEndpoints(endpointResult.data ?? []);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const endpointUrl = (id: string) =>
    endpoints.find((endpoint) => endpoint.id === id)?.url ?? id;

  const loadMore = async () => {
    if (!session || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<Page<WebhookDelivery>>(
        `/webhook-deliveries?limit=25&cursor=${encodeURIComponent(cursor)}`
      );
      setDeliveries((current) => [...current, ...(page.data ?? [])]);
      setCursor(page.next_cursor ?? null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const retry = async (delivery: WebhookDelivery) => {
    if (!session) return;
    setBusy(delivery.id);
    try {
      await api(`/webhook-deliveries/${encodeURIComponent(delivery.id)}/retry`, {
        method: "POST"
      });
      toast.success("Delivery queued for another attempt.");
      setSelected(null);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="Inspect delivery attempts and HTTP outcomes. Payload bodies are not exposed by this API version; retries preserve the attempt history."
      />

      <Panel>
        <PanelHeader
          title="Webhook deliveries"
          description={`${deliveries.length} loaded · ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`}
          action={
            <Button variant="outline" size="sm" className="h-8 text-[11.5px]" onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          }
        />
        {loading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-paper-muted" />
            ))}
          </div>
        ) : deliveries.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No webhook deliveries"
            text="Events are queued for active endpoints when financial records change."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Event", "Endpoint", "Attempts", "Status", "HTTP", "Last error", "Created"].map(
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
                {deliveries.map((item) => (
                  <tr
                    key={item.id}
                    tabIndex={0}
                    onClick={() => setSelected(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(item);
                      }
                    }}
                    className="cursor-pointer border-b border-border/70 text-[12px] last:border-0 hover:bg-paper-muted/50"
                  >
                    <td className="px-5 py-3">
                      <p className="font-mono text-[11px] text-ink-900">{item.event_type}</p>
                      <p className="mt-0.5 font-mono text-[9.5px] text-ink-300">{item.event_id}</p>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 font-mono text-[10.5px] text-ink-500">
                      {endpointUrl(item.endpoint_id)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">{item.attempt_count}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      {item.last_http_status ?? "—"}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-[10.5px] text-ink-500">
                      {item.last_error ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-[10.5px] text-ink-400">
                      {formatDateTime(item.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border px-5 py-2.5">
          <p className="text-[10.5px] text-ink-400">
            Signature headers: X-AegisPay-Timestamp · X-AegisPay-Signature (v1=HMAC-SHA256).
          </p>
          {cursor && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10.5px]"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </Panel>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[520px]">
          {selected && (
            <>
              <SheetHeader className="border-b border-border bg-card px-5 py-4">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selected.status} />
                  <span className="font-mono text-[10.5px] text-ink-400">{selected.id}</span>
                </div>
                <SheetTitle className="mt-1 font-mono text-[14px] tracking-normal text-ink-950">
                  {selected.event_type}
                </SheetTitle>
                <SheetDescription className="text-[11px] text-ink-400">
                  Event {selected.event_id}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 p-5">
                <dl className="grid grid-cols-2 gap-4">
                  {[
                    ["Endpoint", endpointUrl(selected.endpoint_id)],
                    ["Attempts", String(selected.attempt_count)],
                    ["Last HTTP status", selected.last_http_status?.toString() ?? "—"],
                    ["Created", formatDateTime(selected.created_at)],
                    ["Next attempt", selected.next_attempt_at ? formatDateTime(selected.next_attempt_at) : "—"]
                  ].map(([label, value]) => (
                    <div key={label} className={label === "Endpoint" ? "col-span-2" : ""}>
                      <dt className="text-[10.5px] text-ink-400">{label}</dt>
                      <dd className="mt-0.5 break-all font-mono text-[11px] text-ink-800">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {selected.last_error && (
                  <div className="rounded-lg border border-coral/20 bg-coral-soft p-3">
                    <p className="text-[10.5px] font-medium text-[#a83422]">Last error</p>
                    <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#a83422]">
                      {selected.last_error}
                    </p>
                  </div>
                )}
                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="text-[11px] font-medium text-ink-800">Payload</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                    Payload bodies are not exposed by this API version. Delivery evidence above is
                    the available record.
                  </p>
                </div>
                {selected.status === "failed" && (
                  <Button
                    className="h-9 w-full bg-primary text-[12px] font-semibold text-primary-foreground"
                    disabled={busy === selected.id}
                    onClick={() => void retry(selected)}
                  >
                    {busy === selected.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Retry delivery
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
