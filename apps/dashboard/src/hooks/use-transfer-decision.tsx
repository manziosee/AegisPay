"use client";

import { useState } from "react";
import { toast } from "sonner";
import { apiIdempotent, errorMessage } from "@/lib/api";
import { formatMinor } from "@/lib/format";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Transfer } from "@/lib/types";

type DecisionResult = {
  status?: string;
  approvals_received?: number;
  required_approvals?: number;
};

/**
 * Approves or rejects transfers. A rejection asks for a reason first; the
 * returned rejectDialog must be rendered by the page using the hook.
 */
export function useTransferDecision() {
  const { session } = useSession();
  const { refresh } = useWorkspaceData();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState<Transfer | null>(null);
  const [note, setNote] = useState("");

  const submit = async (transfer: Transfer, decision: "approve" | "reject", reason = "") => {
    if (!session) return null;
    setBusyId(transfer.id);
    setError("");
    try {
      const result = await apiIdempotent<DecisionResult>(
        `/transfers/${encodeURIComponent(transfer.id)}/${decision}`,
        reason ? { note: reason } : {}
      );
      const message =
        decision === "reject"
          ? "Transfer rejected."
          : result.status === "completed"
            ? "Transfer approved and posted to the ledger."
            : `Approval recorded (${result.approvals_received ?? 1} of ${
                result.required_approvals ?? 2
              }). Another reviewer must approve before posting.`;
      toast.success(message);
      await refresh();
      return result;
    } catch (decisionError) {
      const message = errorMessage(decisionError);
      setError(message);
      toast.error(message);
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (transfer: Transfer, decision: "approve" | "reject") => {
    if (decision === "reject") {
      setNote("");
      setRejecting(transfer);
      return null;
    }
    return submit(transfer, "approve");
  };

  const confirmReject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = note.trim();
    if (!rejecting || !reason) return;
    const result = await submit(rejecting, "reject", reason);
    if (result) setRejecting(null);
  };

  const rejectDialog = (
    <Dialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
      <DialogContent>
        <form onSubmit={confirmReject} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Reject transfer</DialogTitle>
            <DialogDescription>
              {rejecting
                ? `${formatMinor(rejecting.amount, rejecting.currency)} · ${rejecting.reference}. `
                : ""}
              The reason is recorded in the audit log with your decision.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-note">Reason</Label>
            <Textarea
              id="reject-note"
              value={note}
              maxLength={500}
              required
              onChange={(event) => setNote(event.target.value)}
              placeholder="For example: beneficiary is not on the approved vendor list"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!note.trim() || busyId === rejecting?.id}
              className="bg-coral text-white hover:bg-coral/90"
            >
              {busyId === rejecting?.id ? "Saving…" : "Reject transfer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return { decide, busyId, error, setError, rejectDialog };
}
