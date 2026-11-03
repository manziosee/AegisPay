import { formatMinor } from "./format";
import type { DerivedSignal, Transaction, TransactionPolicy } from "./types";

/**
 * Signals are derived in the browser from records already loaded for this
 * workspace. The fraud service returns score, level, decision and model only,
 * so every derived signal must state its basis.
 */
export function deriveSignals({
  amountMinor,
  currency,
  reference,
  transactions,
  policies
}: {
  amountMinor: number;
  currency: string;
  reference: string;
  transactions: Transaction[];
  policies: TransactionPolicy[];
}): DerivedSignal[] {
  const signals: DerivedSignal[] = [];
  const code = currency.trim().toUpperCase();

  if (amountMinor >= 10_000_000) {
    signals.push({
      code: "AMOUNT_ABOVE_BASELINE",
      description: "Amount is at or above the sandbox review baseline.",
      observed: formatMinor(amountMinor, code),
      basis: "Baseline is 10,000,000 minor units, matching the default approval threshold.",
      severity: "warning"
    });
  }

  if (reference.trim()) {
    const repeated = transactions.filter(
      (transaction) =>
        transaction.reference.toLowerCase() === reference.trim().toLowerCase()
    );
    if (repeated.length > 0) {
      signals.push({
        code: "REPEATED_REFERENCE",
        description: "The reference already appears in loaded transaction records.",
        observed: `${repeated.length} existing record${repeated.length === 1 ? "" : "s"}`,
        basis: "Exact reference match across the most recent transaction page (100 records).",
        severity: "critical"
      });
    }
  }

  const policy = policies.find((item) => item.currency.trim().toUpperCase() === code);
  if (!policy) {
    signals.push({
      code: "POLICY_MISSING",
      description: "No transaction policy is configured for this currency.",
      observed: code,
      basis: "Currency match across the organization transaction policies loaded for this session.",
      severity: "info"
    });
  }

  return signals;
}
