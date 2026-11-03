import type { FraudCase, TimelineEvent, Transaction } from "./types";

/**
 * Only events supported by records already loaded for this workspace are
 * returned. No stage is invented to complete the sequence.
 */
export function buildTransactionTimeline(
  transaction: Transaction,
  fraudCases: FraudCase[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: "created",
      label: "Transaction recorded",
      timestamp: transaction.created_at,
      source: "Ledger report",
      state: transaction.status,
      detail: `${transaction.type} record stored with reference ${transaction.reference}.`
    }
  ];

  const riskCase = fraudCases.find(
    (item) => item.transaction_reference === transaction.reference
  );
  if (riskCase) {
    events.push({
      id: "risk",
      label: "Risk assessment recorded",
      timestamp: riskCase.created_at,
      source: "Fraud review",
      state: riskCase.status,
      detail: `Score ${riskCase.risk_score} · ${riskCase.risk_level} risk · case ${riskCase.id}.`
    });
  }

  return events;
}
