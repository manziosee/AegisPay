"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { Field, FormDialog, SelectField } from "@/components/ui-blocks/form-dialog";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type ChannelKind = "slack" | "teams" | "discord" | "google_chat";

type Channel = {
  id: string;
  kind: ChannelKind;
  name: string;
  url_hint: string;
  events: string[];
  status: string;
  last_delivered_at: string | null;
  last_error: string | null;
};

const KINDS: { value: ChannelKind; label: string; help: string }[] = [
  { value: "slack", label: "Slack", help: "In Slack: Apps → Incoming Webhooks → Add to Slack, pick a channel, then copy the Webhook URL (https://hooks.slack.com/services/…)." },
  { value: "teams", label: "Microsoft Teams", help: "In the Teams channel: ⋯ → Workflows → \"Post to a channel when a webhook request is received\", then copy the URL it gives you." },
  { value: "discord", label: "Discord", help: "In Discord: Server Settings → Integrations → Webhooks → New Webhook, choose the channel, then Copy Webhook URL." },
  { value: "google_chat", label: "Google Chat", help: "In the Google Chat space: Apps & integrations → Webhooks → Add webhook, then copy the URL (https://chat.googleapis.com/…)." }
];

const EVENTS: { value: string; label: string }[] = [
  { value: "transfer.approval_required", label: "Transfer needs approval" },
  { value: "transfer.rejected", label: "Transfer rejected" },
  { value: "transfer.completed", label: "Transfer completed" },
  { value: "collection.succeeded", label: "Payment received" },
  { value: "refund.completed", label: "Refund posted" },
  { value: "fraud.case.opened", label: "Risk case opened" },
  { value: "fraud.case.resolved", label: "Risk case resolved" },
  { value: "reconciliation.import.completed", label: "Bank statement imported" },
  { value: "reconciliation.line.resolved", label: "Reconciliation exception resolved" }
];

const DEFAULT_EVENTS = ["transfer.approval_required", "transfer.rejected", "fraud.case.opened", "reconciliation.import.completed"];

/** Team chat notifications through each platform's incoming webhooks. */
export function NotificationChannels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [form, setForm] = useState({ kind: "slack" as ChannelKind, name: "", url: "", events: DEFAULT_EVENTS });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setChannels((await api<{ data: Channel[] }>("/notification-channels")).data);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (form.events.length === 0) throw new Error("Choose at least one event.");
    const created = await api<Channel>("/notification-channels", {
      method: "POST",
      body: JSON.stringify({ kind: form.kind, name: form.name.trim(), url: form.url.trim(), events: form.events })
    });
    setForm({ kind: "slack", name: "", url: "", events: DEFAULT_EVENTS });
    await load();
    toast.success("Channel added. Sending a test message…");
    await sendTest(created);
  };

  const sendTest = async (channel: Pick<Channel, "id" | "name">) => {
    setBusy(channel.id);
    try {
      await api(`/notification-channels/${encodeURIComponent(channel.id)}/test`, { method: "POST" });
      toast.success(`Test message delivered to ${channel.name}.`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const kind = KINDS.find((item) => item.value === form.kind) ?? KINDS[0];

  return (
    <>
      <Panel className="mb-4">
        <PanelHeader
          title="Team chat notifications"
          description="Approvals, risk cases and statement results in Slack, Teams, Discord or Google Chat"
          action={
            <Button size="sm" className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" />
              Add channel
            </Button>
          }
        />
        {channels.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No chat channels" text="Connect a team chat so approvers see requests where they already work." />
        ) : (
          <ul>
            {channels.map((channel) => (
              <li key={channel.id} className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-ink-900">
                    {channel.name} <span className="font-normal text-ink-400">· {KINDS.find((k) => k.value === channel.kind)?.label}</span>
                  </p>
                  <p className="truncate text-[10.5px] text-ink-400">
                    {channel.url_hint} · {channel.events.length} event types
                    {channel.last_delivered_at ? ` · last message ${formatRelative(channel.last_delivered_at)}` : ""}
                  </p>
                  {channel.last_error && <p className="truncate text-[10.5px] text-coral">Last error: {channel.last_error}</p>}
                </div>
                <StatusBadge status={channel.last_error ? "failed" : channel.status} label={channel.last_error ? "error" : channel.status} />
                <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy === channel.id} onClick={() => void sendTest(channel)}>
                  {busy === channel.id ? "Sending…" : "Send test"}
                </Button>
                <Button size="sm" variant="outline" className="h-7 border-coral/30 text-[11px] text-coral" onClick={() => setRemoving(channel)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <FormDialog open={open} onOpenChange={setOpen} title="Add a chat channel" description="Paste the incoming-webhook link from your chat app. It is stored encrypted." submitLabel="Add and send test" onSubmit={create}>
        <SelectField id="channel-kind" label="Chat app" required value={form.kind} onChange={(value) => setForm({ ...form, kind: value as ChannelKind })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <p className="rounded-md bg-paper-muted p-2.5 text-[11px] leading-relaxed text-ink-600">{kind.help}</p>
        <Field id="channel-url" label="Webhook URL" type="url" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <Field id="channel-name" label="Name (optional)" placeholder={`${kind.label} – finance`} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-medium">Notify about</legend>
          <div className="grid grid-cols-1 gap-1 rounded-md border border-border p-3 sm:grid-cols-2">
            {EVENTS.map((event) => (
              <label key={event.value} className="flex items-center gap-1.5 text-[11.5px]">
                <input
                  type="checkbox"
                  checked={form.events.includes(event.value)}
                  onChange={() =>
                    setForm({ ...form, events: form.events.includes(event.value) ? form.events.filter((e) => e !== event.value) : [...form.events, event.value] })
                  }
                />
                {event.label}
              </label>
            ))}
          </div>
        </fieldset>
      </FormDialog>

      <FormDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={`Remove ${removing?.name ?? "channel"}`}
        description="AegisPay stops posting to this chat. You can add it again later."
        destructive
        submitLabel="Remove channel"
        onSubmit={async () => {
          if (!removing) return;
          await api(`/notification-channels/${encodeURIComponent(removing.id)}`, { method: "DELETE" });
          toast.success("Channel removed.");
          await load();
        }}
      >
        <></>
      </FormDialog>
    </>
  );
}
