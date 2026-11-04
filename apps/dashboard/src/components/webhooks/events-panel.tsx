"use client";

import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { EventRecord, Page } from "@/lib/types";

/** Event log with payloads and replay to current endpoints. */
export function EventsPanel({ onReplay }: { onReplay: () => Promise<void> }) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (type) query.set("type", type);
        if (after) query.set("cursor", after);
        const page = await api<Page<EventRecord>>(`/events?${query}`);
        setEvents((current) => (after ? [...current, ...page.data] : page.data));
        setCursor(page.has_more ? page.next_cursor : null);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [type]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const replay = async (event: EventRecord) => {
    setBusy(event.id);
    try {
      const result = await api<{ deliveries_queued: number }>(`/events/${encodeURIComponent(event.id)}/replay`, { method: "POST" });
      toast.success(
        result.deliveries_queued === 0
          ? "No active endpoint subscribes to this event type."
          : `Queued ${result.deliveries_queued} deliver${result.deliveries_queued === 1 ? "y" : "ies"}.`
      );
      await Promise.all([load(), onReplay()]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="mt-4">
      <PanelHeader
        title="Event log"
        description="Every event AegisPay emitted for this workspace"
        action={
          <select
            aria-label="Filter by event type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-[11.5px]"
          >
            <option value="">All types</option>
            {["collection.succeeded", "refund.completed", "transfer.completed", "transfer.approval_required", "transfer.approved", "transfer.rejected", "fraud.case.opened", "fraud.case.resolved", "reconciliation.import.completed", "reconciliation.line.resolved", "test.ping"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        }
      />
      {events.length === 0 ? (
        <EmptyState icon={History} title="No events" text="Events appear when collections, transfers, reviews and imports change." />
      ) : (
        <ul>
          {events.map((event) => (
            <li key={event.id} className="border-b border-border/70 last:border-0">
              <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === event.id ? null : event.id)} aria-expanded={open === event.id}>
                  <p className="font-mono text-[11.5px] text-ink-900">{event.type}</p>
                  <p className="text-[10.5px] text-ink-400">
                    {event.id} · {formatDateTime(event.created_at)} · {event.delivered}/{event.deliveries} delivered
                  </p>
                </button>
                {event.type !== "test.ping" && (
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy === event.id} onClick={() => void replay(event)}>
                    {busy === event.id ? "Queuing…" : "Replay"}
                  </Button>
                )}
              </div>
              {open === event.id && (
                <pre className="mx-5 mb-3 overflow-x-auto rounded-md bg-paper-muted p-3 text-[10.5px]">{JSON.stringify(event.data, null, 2)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="border-t border-border p-3 text-center">
          <Button variant="outline" className="h-8 text-[11.5px]" onClick={() => void load(cursor)}>
            Load more
          </Button>
        </div>
      )}
    </Panel>
  );
}
