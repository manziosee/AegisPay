"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileArchive, FileCheck2, ShieldCheck, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, apiBlob, downloadBlob, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, truncateMiddle } from "@/lib/format";
import type { AuditAnchor, AuditVerification } from "@/lib/types";

const KEYS_URL = "https://aegispay.fly.dev/audit-pack-keys";

function previousMonth() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function thisMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function AuditProofPage() {
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [anchors, setAnchors] = useState<AuditAnchor[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [anchorError, setAnchorError] = useState("");
  const [month, setMonth] = useState(previousMonth());
  const [packing, setPacking] = useState(false);
  const [downloading, setDownloading] = useState("");

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      setVerification(await api<AuditVerification>("/audit-logs/verify"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setVerifying(false);
    }
  }, []);

  useEffect(() => {
    void verify();
    void (async () => {
      try {
        const result = await api<{ data: AuditAnchor[]; enabled: boolean }>("/audit-logs/anchors");
        setAnchors(result.data);
        setEnabled(result.enabled);
      } catch (error) {
        setAnchorError(errorMessage(error));
      }
    })();
  }, [verify]);

  const download = async (anchor: AuditAnchor, kind: "statement" | "proof") => {
    const key = `${anchor.date}-${kind}`;
    setDownloading(key);
    try {
      const blob = await apiBlob(`/audit-logs/anchors/${anchor.date}/${kind}`);
      downloadBlob(blob, `aegispay-audit-${anchor.date}.txt${kind === "proof" ? ".ots" : ""}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDownloading("");
    }
  };

  const downloadPack = async () => {
    setPacking(true);
    try {
      const blob = await apiBlob(`/reports/audit-pack?month=${encodeURIComponent(month)}`);
      downloadBlob(blob, `aegispay-audit-pack-${month}.zip`);
      toast.success("Audit pack downloaded.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPacking(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Audit proof"
        description="Show auditors, donors and partners that your records were not changed after the fact."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader
            title="Audit chain"
            description="Every audit entry includes the hash of the one before it, so any edit breaks the chain."
            action={
              <Button variant="outline" size="sm" className="h-8 text-[11px]" disabled={verifying} onClick={() => void verify()}>
                <ShieldCheck className="size-3.5" />
                {verifying ? "Checking…" : "Check again"}
              </Button>
            }
          />
          <div className="px-5 pb-5 pt-3">
            {!verification ? (
              <p className="text-[12px] text-ink-400">Checking…</p>
            ) : verification.valid ? (
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-mint" aria-hidden />
                <div>
                  <p className="text-[13px] font-semibold text-ink-950">Intact</p>
                  <p className="mt-1 text-[12px] text-ink-600">
                    {verification.checked === 1 ? "Its one entry was" : `All ${verification.checked.toLocaleString()} entries were`} recomputed and
                    linked correctly
                    {verification.anchors_checked
                      ? `, and they match ${verification.anchors_checked} daily public ${verification.anchors_checked === 1 ? "timestamp" : "timestamps"}.`
                      : "."}
                  </p>
                  {verification.head_hash && (
                    <p className="mt-2 break-all font-mono text-[10.5px] text-ink-400">Latest hash {verification.head_hash}</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <ShieldX className="mt-0.5 size-5 shrink-0 text-coral" aria-hidden />
                <div>
                  <p className="text-[13px] font-semibold text-ink-950">Broken</p>
                  <p className="mt-1 text-[12px] text-ink-600">{verification.detail}</p>
                  <p className="mt-1 font-mono text-[10.5px] text-ink-400">First bad entry {verification.first_invalid_id}</p>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Month-end audit pack" description="One signed ZIP for your auditor: ledger, approvals, reconciliations, risk decisions and the audit log." />
          <div className="space-y-3 px-5 pb-5 pt-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="pack-month" className="text-[11.5px]">
                  Month
                </Label>
                <Input
                  id="pack-month"
                  type="month"
                  value={month}
                  max={thisMonth()}
                  onChange={(event) => setMonth(event.target.value)}
                  className="h-9 w-[170px] text-[12px]"
                />
              </div>
              <Button className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground" disabled={packing || !month} onClick={() => void downloadPack()}>
                <FileArchive className="size-3.5" />
                {packing ? "Preparing…" : "Download audit pack"}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-500">
              The pack includes a manifest with every file&apos;s SHA-256, signed with AegisPay&apos;s Ed25519 key, the result of checking
              the audit chain, and that month&apos;s public timestamps. Instructions for checking it are in its README.
            </p>
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHeader
          title="Daily public timestamps"
          description="Each day, the chain's latest hash is timestamped on the Bitcoin blockchain through OpenTimestamps, a free public service."
        />
        {anchorError ? (
          <EmptyState icon={FileCheck2} title="Timestamps could not be loaded" text={anchorError} />
        ) : anchors === null ? (
          <p className="px-5 py-4 text-[12px] text-ink-400">Loading…</p>
        ) : anchors.length === 0 ? (
          <EmptyState
            icon={FileCheck2}
            title={enabled ? "No timestamps yet" : "Daily timestamps are switched off on this server"}
            text={
              enabled
                ? "The first one is made the day after your workspace records its first audit entry."
                : "Set AUDIT_ANCHOR_CALENDARS on the API to turn them on."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-border bg-paper-muted/60">
                  {["Day", "Status", "Entries", "Chain hash", ""].map((h, i) => (
                    <th key={h || i} className="px-4 py-2 text-[10.5px] font-medium text-ink-400 first:pl-5 last:pr-5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {anchors.map((anchor) => (
                  <tr key={anchor.date} className="border-b border-border/70 last:border-0">
                    <td className="whitespace-nowrap px-5 py-2.5 text-ink-800">{formatDate(`${anchor.date}T12:00:00Z`)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={anchor.status === "stamped" ? "completed" : anchor.status} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-ink-600">{anchor.entry_count.toLocaleString()}</td>
                    <td className="px-4 py-2.5 font-mono text-[10.5px] text-ink-500" title={anchor.head_hash}>
                      {truncateMiddle(anchor.head_hash, 22)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[11px]"
                        disabled={downloading !== ""}
                        onClick={() => void download(anchor, "statement")}
                      >
                        <Download className="size-3" />
                        Statement
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[11px]"
                        disabled={downloading !== "" || anchor.status !== "stamped"}
                        onClick={() => void download(anchor, "proof")}
                      >
                        <Download className="size-3" />
                        Proof (.ots)
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border px-5 py-4">
          <h3 className="text-[12px] font-semibold text-ink-900">How anyone can check a day</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-ink-600">
            <li>Download the statement and its proof for that day and keep them together.</li>
            <li>
              Install the free OpenTimestamps tool: <code className="font-mono text-[11px]">pip install opentimestamps-client</code>
            </li>
            <li>
              Run <code className="font-mono text-[11px]">ots verify aegispay-audit-DAY.txt.ots</code>. It confirms the statement existed
              on that day. New proofs need a few hours to reach a Bitcoin block; until then the tool reports them as pending.
            </li>
            <li>
              The statement names the last entry of that day and its hash. The audit chain check above recomputes the chain and confirms it
              still matches every stamped day.
            </li>
          </ol>
          <p className="mt-2 text-[10.5px] text-ink-400">
            Audit pack signing keys are published at <span className="font-mono">{KEYS_URL}</span>. Last checked{" "}
            {verification ? formatDateTime(new Date()) : "—"}.
          </p>
        </div>
      </Panel>
    </div>
  );
}
