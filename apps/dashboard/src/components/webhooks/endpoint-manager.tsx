"use client";

import { useState } from "react";
import { Copy, Plus, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
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

export function WebhookEndpointManager({
  endpoints,
  onChange
}: {
  endpoints: WebhookEndpoint[];
  onChange: () => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["collection.succeeded", "refund.completed", "transfer.completed"]);
  const [disabling, setDisabling] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const create = async () => {
    if (events.length === 0) throw new Error("Choose at least one event.");
    const created = await api<{ signing_secret: string }>("/webhook-endpoints", {
      method: "POST",
      body: JSON.stringify({ url: url.trim(), events })
    });
    setSecret(created.signing_secret);
    setUrl("");
    await onChange();
  };

  const disable = async () => {
    if (!disabling) return;
    await api(`/webhook-endpoints/${encodeURIComponent(disabling.id)}/disable`, { method: "POST" });
    toast.success("Endpoint disabled. Pending deliveries to it stop.");
    await onChange();
  };

  return (
    <>
      <Panel className="mb-4">
        <PanelHeader
          title="Endpoints"
          description="HTTPS URLs that receive signed event notifications"
          action={
            <Button size="sm" className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              Add endpoint
            </Button>
          }
        />
        {endpoints.length === 0 ? (
          <EmptyState icon={Webhook} title="No endpoints" text="Add an HTTPS endpoint to receive events as they happen." />
        ) : (
          <ul>
            {endpoints.map((endpoint) => (
              <li key={endpoint.id} className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11.5px] text-ink-900">{endpoint.url}</p>
                  <p className="mt-0.5 truncate text-[10.5px] text-ink-400">
                    {(endpoint.events ?? []).join(", ")} · added {formatDate(endpoint.created_at)}
                  </p>
                </div>
                <StatusBadge status={endpoint.status ?? "active"} />
                {endpoint.status !== "disabled" && (
                  <Button size="sm" variant="outline" className="h-7 border-coral/30 text-[11px] text-coral" onClick={() => setDisabling(endpoint)}>
                    Disable
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add a webhook endpoint"
        description="The URL must be public HTTPS. Private, loopback and cloud-metadata addresses are refused."
        submitLabel="Add endpoint"
        onSubmit={create}
      >
        <Field id="webhook-url" label="Endpoint URL" type="url" required placeholder="https://example.com/aegispay/webhooks" value={url} onChange={(e) => setUrl(e.target.value)} />
        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-medium">Events</legend>
          <div className="grid grid-cols-1 gap-1 rounded-md border border-border p-3 sm:grid-cols-2">
            {EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  onChange={() =>
                    setEvents((current) => (current.includes(event) ? current.filter((e) => e !== event) : [...current, event]))
                  }
                />
                <span className="font-mono">{event}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </FormDialog>

      <FormDialog
        open={disabling !== null}
        onOpenChange={(next) => !next && setDisabling(null)}
        title="Disable endpoint"
        description={`${disabling?.url ?? ""} stops receiving events. Add it again to resume with a new signing secret.`}
        destructive
        submitLabel="Disable endpoint"
        onSubmit={disable}
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
