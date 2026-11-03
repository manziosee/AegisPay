"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, idempotencyKey } from "@/lib/api";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import type { Transfer } from "@/lib/types";

type DecisionResult = {
  status?: string;
  approvals_received?: number;
  required_approvals?: number;
};

export function useTransferDecision() {
  const { session } = useSession();
  const { refresh } = useWorkspaceData();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const decide = async (transfer: Transfer, decision: "approve" | "reject") => {
    if (!session) return null;
    setBusyId(transfer.id);
    setError("");
    try {
      const result = await api<DecisionResult>(
        `/transfers/${encodeURIComponent(transfer.id)}/${decision}`,
        session.access_token,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify({})
        }
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

  return { decide, busyId, error, setError };
}
