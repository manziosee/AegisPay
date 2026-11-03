import type { Transaction } from "./types";

/** One sample identity reused across marketing and auth. Every surface labels it. */
export const SAMPLE_TRANSACTION: Transaction = {
  id: "col_8f3a71c2d904",
  type: "collection",
  status: "succeeded",
  reference: "COL-2048",
  amount_minor: 4200,
  currency: "RWF",
  created_at: "2026-11-03T08:42:00.000Z"
};

export type SampleEvent = {
  id: string;
  label: string;
  timestamp: string;
  source: string;
  state: string;
  detail: string;
};

export const SAMPLE_EVENTS: Array<{
  id: string;
  label: string;
  timestamp: string;
  source: string;
  state: string;
  fields: Array<[string, string]>;
  detail: string;
}> = [
  {
    id: "created",
    label: "Created",
    timestamp: "10:42:03",
    source: "POST /v1/collections",
    state: "Recorded",
    fields: [
      ["Reference", "COL-2048"],
      ["Amount", "RWF 4,200"],
      ["Customer", "cus_7f1e9a"],
      ["Currency", "RWF"]
    ],
    detail: "The collection record is written before any risk or ledger work begins."
  },
  {
    id: "risk",
    label: "Risk assessed",
    timestamp: "10:42:04",
    source: "POST /v1/fraud/analyze",
    state: "Review",
    fields: [
      ["Risk score", "78 / 100"],
      ["Level", "high"],
      ["Decision", "review"],
      ["Model", "rules-baseline-v1"]
    ],
    detail: "A risk assessment is stored against the transaction reference. Review cases are opened only when the decision is review or block."
  },
  {
    id: "approval",
    label: "Approval required",
    timestamp: "10:43:11",
    source: "POST /v1/transfers/{id}/approve",
    state: "1 of 2",
    fields: [
      ["Approvals received", "1"],
      ["Required", "2"],
      ["Policy", "RWF approval threshold"],
      ["Initiator", "distinct user"]
    ],
    detail: "Maker-checker is enforced by the API: the initiator cannot approve their own transfer, and one reviewer cannot vote twice."
  },
  {
    id: "ledger",
    label: "Ledger posted",
    timestamp: "10:44:02",
    source: "journal_entries · journal_lines",
    state: "Posted",
    fields: [
      ["Entry", "jrn_2b8e…"],
      ["Debit", "sandbox clearing"],
      ["Credit", "RWF wallet"],
      ["Amount", "RWF 4,200"]
    ],
    detail: "Once the required approvals are met, the double-entry posting is committed in the same database transaction."
  },
  {
    id: "reconciled",
    label: "Reconciled",
    timestamp: "11:03:26",
    source: "POST /v1/reconciliation/imports",
    state: "Matched",
    fields: [
      ["Statement reference", "COL-2048"],
      ["Net amount", "RWF 4,158"],
      ["Provider fee", "RWF 42"],
      ["Import", "imp_91c2…"]
    ],
    detail: "A statement line matches the collection by reference, currency and gross amount. Exceptions stay open until a finance operator resolves them with a note."
  },
  {
    id: "webhook",
    label: "Webhook delivered",
    timestamp: "11:03:27",
    source: "outbox_events · webhook_deliveries",
    state: "Signed",
    fields: [
      ["Event", "collection.succeeded"],
      ["Signature", "HMAC-SHA256"],
      ["Attempts", "1"],
      ["Endpoint", "HTTPS only"]
    ],
    detail: "Deliveries carry a timestamped HMAC-SHA256 signature and are retried on bounded backoff. Private network addresses are rejected."
  }
];
