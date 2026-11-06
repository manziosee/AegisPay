"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/ui-blocks/panel";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { api, errorMessage } from "@/lib/api";
import { isAdmin } from "@/lib/roles";

type Status = {
  environment: "sandbox" | "live";
  sample_data_loaded: boolean;
  email_verified: boolean;
  imported_statement: boolean;
  created_collection: boolean;
  invited_teammate: boolean;
  connected_chat: boolean;
};

/** First-run checklist on the overview, with one-click sample data in practice workspaces. */
export function GettingStarted() {
  const { session, role } = useSession();
  const { refresh } = useWorkspaceData();
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [loading, setLoading] = useState(false);
  const key = `aegispay.checklist-dismissed.${session?.organization_id ?? ""}`;

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/onboarding/status"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    try {
      setDismissed(Boolean(localStorage.getItem(key)));
    } catch {
      setDismissed(false);
    }
    void load();
  }, [key, load, session]);

  if (!status || dismissed) return null;

  const steps = [
    { done: status.email_verified, label: "Confirm your email", href: "/app/settings" },
    { done: status.created_collection, label: "Record a payment you expect", href: "/app/payments" },
    { done: status.imported_statement, label: "Import a bank statement", href: "/app/money#statement" },
    { done: status.invited_teammate, label: "Invite an approver", href: "/app/team" },
    { done: status.connected_chat, label: "Connect your team chat", href: "/app/webhooks" }
  ];
  const remaining = steps.filter((step) => !step.done).length;
  if (remaining === 0 && (status.sample_data_loaded || status.environment === "live")) return null;

  const loadSample = async () => {
    setLoading(true);
    try {
      const result = await api<{ currency: string }>("/onboarding/sample-data", { method: "POST", body: "{}" });
      toast.success(`Sample data added in ${result.currency}. Everything is marked SAMPLE and uses simulated money.`);
      await Promise.all([load(), refresh()]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel className="mb-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-900">Get started</h2>
          <p className="text-[11.5px] text-ink-500">{steps.length - remaining} of {steps.length} done</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Dismiss getting started"
          className="size-7 p-0 text-ink-400"
          onClick={() => {
            try {
              localStorage.setItem(key, "1");
            } catch {
              // The checklist simply returns next visit.
            }
            setDismissed(true);
          }}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step) => (
          <li key={step.label}>
            <Link href={step.href} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px] text-ink-700 hover:bg-paper-muted/60">
              {step.done ? <CheckCircle2 className="size-3.5 shrink-0 text-mint" /> : <Circle className="size-3.5 shrink-0 text-ink-300" />}
              <span className={step.done ? "text-ink-400 line-through" : ""}>{step.label}</span>
            </Link>
          </li>
        ))}
      </ul>
      {status.environment === "sandbox" && !status.sample_data_loaded && isAdmin(role ?? undefined) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-primary-soft/60 p-3">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-[12px] text-ink-700">See AegisPay with a month of example activity. It stays in this practice workspace and every reference starts with SAMPLE.</p>
          <Button size="sm" className="h-8 bg-primary text-[11.5px] font-semibold text-primary-foreground" disabled={loading} onClick={() => void loadSample()}>
            {loading ? "Adding…" : "Load sample data"}
          </Button>
        </div>
      )}
    </Panel>
  );
}
