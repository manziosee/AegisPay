"use client";

import { useState } from "react";
import {
  Copy,
  Eye,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCw,
  Trash2,
  Webhook
} from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import type { WebhookEndpoint } from "@/lib/types";

const EVENTS = [
  "collection.succeeded",
  "refund.completed",
  "transfer.completed",
  "transfer.approval_required",
  "transfer.approved",
  "transfer.rejected",
  "fraud.case.opened",
  "fraud.case.resolved",
  "reconciliation.import.completed",
  "reconciliation.line.resolved"
];

const VERIFY_SNIPPET = `// Node.js: verify an AegisPay webhook
const crypto = require("crypto");
function verify(rawBody, headers, secret) {
  const timestamp = headers["x-aegispay-timestamp"];
  const expected = "v1=" + crypto.createHmac("sha256", secret)
    .update(timestamp + "." + rawBody).digest("hex");
  const received = Buffer.from(headers["x-aegispay-signature"] || "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), received);
}`;

function EventPicker({
  selected,
  onChange
}: {
  selected: string[];
  onChange: (events: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] font-medium">Events</legend>
      <div className="grid grid-cols-1 gap-1 rounded-md border border-border p-3 sm:grid-cols-2">
        {EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={selected.includes(event)}
              onChange={() =>
                onChange(
                  selected.includes(event)
                    ? selected.filter((item) => item !== event)
                    : [...selected, event]
                )
              }
            />
            <span className="font-mono">{event}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function WebhookEndpointManager({
  endpoints,
  onChange
}: {
  endpoints: WebhookEndpoint[];
  onChange: () => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([
    "collection.succeeded",
    "refund.completed",
    "transfer.completed"
  ]);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [disabling, setDisabling] = useState<WebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<WebhookEndpoint | null>(null);
  const [busy, setBusy] = useState("");

  const viewing = endpoints.find((endpoint) => endpoint.id === viewingId) ?? null;

  const sendTest = async (endpoint: WebhookEndpoint) => {
    setBusy(`test:${endpoint.id}`);
    try {
      await api(`/webhook-endpoints/${encodeURIComponent(endpoint.id)}/test`, {
        method: "POST"
      });
      toast.success("Test event queued. It appears under deliveries within a few seconds.");
      await onChange();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const rotate = async () => {
    if (!rotating) return;
    const result = await api<{ signing_secret: string }>(
      `/webhook-endpoints/${encodeURIComponent(rotating.id)}/rotate-secret`,
      { method: "POST" }
    );
    setSecret(result.signing_secret);
    await onChange();
  };

  const create = async () => {
    if (events.length === 0) throw new Error("Choose at least one event.");
    const created = await api<{ signing_secret: string }>("/webhook-endpoints", {
      method: "POST",
      body: JSON.stringify({ url: url.trim(), events })
    });
    setSecret(created.signing_secret);
    setUrl("");
    setCreateOpen(false);
    await onChange();
  };

  const openEdit = (endpoint: WebhookEndpoint) => {
    setEditUrl(endpoint.url);
    setEditEvents(endpoint.events ?? []);
    setEditing(endpoint);
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (editEvents.length === 0) throw new Error("Choose at least one event.");
    await api(`/webhook-endpoints/${encodeURIComponent(editing.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ url: editUrl.trim(), events: editEvents })
    });
    toast.success("Endpoint updated.");
    setEditing(null);
    await onChange();
  };

  const disable = async () => {
    if (!disabling) return;
    setBusy(`disable:${disabling.id}`);
    try {
      await api(`/webhook-endpoints/${encodeURIComponent(disabling.id)}/disable`, {
        method: "POST"
      });
      toast.success("Endpoint disabled. Pending deliveries to it stop.");
      setDisabling(null);
      await onChange();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const enable = async (endpoint: WebhookEndpoint) => {
    setBusy(`enable:${endpoint.id}`);
    try {
      await api(`/webhook-endpoints/${encodeURIComponent(endpoint.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" })
      });
      toast.success("Endpoint re-enabled.");
      await onChange();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(`delete:${deleting.id}`);
    try {
      await api(`/webhook-endpoints/${encodeURIComponent(deleting.id)}`, {
        method: "DELETE"
      });
      toast.success("Endpoint deleted.");
      setDeleting(null);
      if (viewingId === deleting.id) setViewingId(null);
      await onChange();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <Panel className="mb-4">
        <PanelHeader
          title="Endpoints"
          description="HTTPS URLs that receive signed event notifications"
          action={
            <Button
              size="sm"
              className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" />
              Add endpoint
            </Button>
          }
        />
        {endpoints.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No endpoints"
            text="Add an HTTPS endpoint to receive events as they happen."
          />
        ) : (
          <ul>
            {endpoints.map((endpoint) => (
              <li
                key={endpoint.id}
                className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setViewingId(endpoint.id)}
                >
                  <p className="truncate font-mono text-[11.5px] text-ink-900">{endpoint.url}</p>
                  <p className="mt-0.5 truncate text-[10.5px] text-ink-400">
                    {(endpoint.events ?? []).length} event
                    {(endpoint.events ?? []).length === 1 ? "" : "s"} · added{" "}
                    {formatDate(endpoint.created_at)}
                  </p>
                </button>
                <StatusBadge status={endpoint.status ?? "active"} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${endpoint.url}`}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => setViewingId(endpoint.id)}>
                      <Eye className="size-3.5" />
                      View endpoint
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openEdit(endpoint)}>
                      <Pencil className="size-3.5" />
                      Edit endpoint
                    </DropdownMenuItem>
                    {(endpoint.status ?? "active") === "active" ? (
                      <>
                        <DropdownMenuItem
                          onSelect={() => void sendTest(endpoint)}
                          disabled={busy === `test:${endpoint.id}`}
                        >
                          <Play className="size-3.5" />
                          Send test
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setRotating(endpoint)}>
                          <RotateCw className="size-3.5" />
                          Rotate secret
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setDisabling(endpoint)}>
                          <Power className="size-3.5" />
                          Disable endpoint
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => void enable(endpoint)}
                        disabled={busy === `enable:${endpoint.id}`}
                      >
                        <Power className="size-3.5" />
                        Re-enable endpoint
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleting(endpoint)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete endpoint
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Sheet open={Boolean(viewing)} onOpenChange={(open) => !open && setViewingId(null)}>
        <SheetContent className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[480px]">
          {viewing && (
            <>
              <SheetHeader className="border-b border-border bg-card px-5 py-4">
                <div className="flex items-center gap-2">
                  <StatusBadge status={viewing.status ?? "active"} />
                  <span className="font-mono text-[10.5px] text-ink-400">{viewing.id}</span>
                </div>
                <SheetTitle className="mt-1 break-all font-mono text-[13px] tracking-normal text-ink-950">
                  {viewing.url}
                </SheetTitle>
                <SheetDescription className="text-[11px] text-ink-400">
                  Signing secret is shown only when created or rotated.
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-5">
                <dl className="divide-y divide-border rounded-lg border border-border bg-card">
                  {[
                    ["Status", viewing.status ?? "active"],
                    ["Created", formatDateTime(viewing.created_at)],
                    ["Endpoint ID", viewing.id]
                  ].map(([label, value]) => (
                    <div key={label} className="px-4 py-3">
                      <dt className="text-[10.5px] text-ink-400">{label}</dt>
                      <dd className="mt-0.5 break-all font-mono text-[11px] text-ink-800">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div>
                  <p className="text-[10.5px] text-ink-400">Subscribed events</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {(viewing.events ?? []).map((event) => (
                      <li
                        key={event}
                        className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-700"
                      >
                        {event}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="text-[10.5px] leading-relaxed text-ink-400">
                  Deleting an endpoint stops deliveries and hides it from this list. Delivery
                  evidence already recorded is retained.
                </p>
              </div>
              <SheetFooter className="border-t border-border bg-card px-5 py-4">
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
                    Edit endpoint
                  </Button>
                  {viewing.status === "active" ? (
                    <Button
                      variant="outline"
                      className="h-9 text-[12px]"
                      onClick={() => {
                        setDisabling(viewing);
                        setViewingId(null);
                      }}
                    >
                      <Power className="size-3.5" />
                      Disable endpoint
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="h-9 text-[12px]"
                      disabled={busy === `enable:${viewing.id}`}
                      onClick={() => void enable(viewing)}
                    >
                      <Power className="size-3.5" />
                      Re-enable endpoint
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="h-9 border-coral/30 text-[12px] text-coral hover:bg-coral-soft"
                    onClick={() => {
                      setDeleting(viewing);
                      setViewingId(null);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Delete endpoint
                  </Button>
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add a webhook endpoint"
        description="The URL must be public HTTPS. Private, loopback and cloud-metadata addresses are refused."
        submitLabel="Add endpoint"
        onSubmit={create}
      >
        <Field
          id="webhook-url"
          label="Endpoint URL"
          type="url"
          required
          placeholder="https://example.com/aegispay/webhooks"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <EventPicker selected={events} onChange={setEvents} />
      </FormDialog>

      <FormDialog
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title="Edit webhook endpoint"
        description="Changes are applied to future deliveries. The signing secret is unchanged."
        submitLabel="Save endpoint"
        onSubmit={saveEdit}
      >
        <Field
          id="webhook-edit-url"
          label="Endpoint URL"
          type="url"
          required
          value={editUrl}
          onChange={(event) => setEditUrl(event.target.value)}
        />
        <EventPicker selected={editEvents} onChange={setEditEvents} />
      </FormDialog>

      <FormDialog
        open={disabling !== null}
        onOpenChange={(next) => !next && setDisabling(null)}
        title="Disable endpoint"
        description={`${disabling?.url ?? ""} stops receiving events. Re-enable it from the endpoint actions when ready.`}
        destructive
        submitLabel="Disable endpoint"
        onSubmit={disable}
      >
        <></>
      </FormDialog>

      <FormDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title="Delete endpoint"
        description={`${deleting?.url ?? ""} is removed from this list and stops receiving events. Delivery evidence is retained.`}
        destructive
        submitLabel="Delete endpoint"
        onSubmit={remove}
      >
        <></>
      </FormDialog>

      <FormDialog
        open={rotating !== null}
        onOpenChange={(next) => !next && setRotating(null)}
        title="Rotate signing secret"
        description={`The current secret for ${rotating?.url ?? ""} stops working immediately. Update your receiver with the new secret.`}
        destructive
        submitLabel="Rotate secret"
        onSubmit={rotate}
      >
        <></>
      </FormDialog>

      <Dialog open={secret !== null} onOpenChange={(next) => !next && setSecret(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Copy the signing secret</DialogTitle>
            <DialogDescription className="text-[12px]">
              Shown once. Use it to verify the X-AegisPay-Signature header on every delivery.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-paper-muted p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11.5px]">{secret}</code>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => {
                void navigator.clipboard.writeText(secret ?? "");
                toast.success("Signing secret copied.");
              }}
            >
              <Copy className="size-3" />
              Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-ink-900 p-3 text-[10.5px] leading-relaxed text-on-night">{VERIFY_SNIPPET}</pre>
          <div className="flex justify-end">
            <Button className="h-9 text-[12px]" onClick={() => setSecret(null)}>
              I have stored it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
