export type Role =
  | "owner"
  | "admin"
  | "finance_operator"
  | "fraud_analyst"
  | "developer"
  | "auditor";

export type WorkspaceType = "personal" | "business";

export type Session = {
  access_token: string;
  user_id: string;
  full_name?: string;
  organization_id: string;
  role: Role;
  expires_at: string;
};

export type Principal = {
  organization_id: string;
  user_id: string;
  role: Role;
  credential_type: string;
};

export type Organization = {
  id: string;
  name: string;
  workspace_type: WorkspaceType;
  slug: string;
  country_code: string;
  status: string;
  created_at: string;
};

export type Page<T> = {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export type TransactionType = "collection" | "transfer" | "refund";

export type Transaction = {
  id: string;
  type: TransactionType | string;
  status: string;
  reference: string;
  amount_minor: number;
  currency: string;
  created_at: string;
};

export type TransactionSummary = {
  type: string;
  status: string;
  currency: string;
  count: number;
  amount_minor: number;
};

export type TransactionReport = Page<Transaction> & {
  mode: string;
  summary: TransactionSummary[];
  from: string;
  to: string;
};

export type Transfer = {
  id: string;
  status: string;
  currency: string;
  reference: string;
  amount: number;
  created_at: string;
  approvals_received?: number;
  required_approvals?: number;
};

export type FraudCase = {
  id: string;
  status: string;
  priority: string;
  created_at: string;
  transaction_reference: string;
  risk_score: number;
  risk_level: string;
};

export type RiskDecision = "allow" | "review" | "block";

export type FraudAssessment = {
  id: string;
  transaction_reference: string;
  risk_score: number;
  risk_level: string;
  decision: RiskDecision;
  model_version: string;
  mode: string;
  case_id: string | null;
};

export type ReconciliationImport = {
  id: string;
  status: string;
  source_name: string;
  line_count: number;
  matched_count: number;
  exception_count: number;
  created_at: string;
};

export type ReconciliationLine = {
  line_id: number;
  external_reference: string;
  amount: number;
  provider_fee: number;
  gross_amount: number;
  currency: string;
  transaction_date: string;
  match_status: string;
  collection_id: string | null;
  suggestion_reason?: string;
  duplicate_of?: number | null;
  payment_request_id?: string | null;
  payout_id?: string | null;
};

export type TransactionPolicy = {
  currency: string;
  max_single_minor: number | null;
  daily_collection_minor: number | null;
  daily_transfer_minor: number | null;
  approval_threshold_minor: number | null;
  required_approvals: number;
  updated_at: string;
};

export type Account = {
  id: string;
  customer_id: string | null;
  currency: string;
  account_type: string;
  status: string;
  created_at: string;
  balance_minor?: number;
  balanceError?: string;
};

export type Collection = {
  id: string;
  status: string;
  currency: string;
  reference: string;
  description: string;
  amount: number;
  created_at: string;
};

export type LedgerEntry = {
  id: string;
  reference_type: string;
  reference_id: string;
  currency: string;
  amount: number;
  created_at: string;
};

export type BankRequest = {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  description: string;
  due_date: string | null;
  status: string;
  created_at?: string;
};

export type PayoutStatus =
  | "prepared"
  | "pending_approval"
  | "exported_for_manual_entry"
  | "submitted_to_bank"
  | "rejected";

export type BankPayout = {
  id: string;
  beneficiary_name: string;
  amount: number;
  currency: string;
  reference: string;
  description: string;
  status: PayoutStatus | string;
  approvals_received?: number;
  required_approvals?: number;
  created_at?: string;
};

export type ClosePeriod = {
  id: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed" | string;
  close_note: string;
  created_at?: string;
  closed_at?: string | null;
};

export type AuditEntry = {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Delegation = {
  id: string;
  delegator_name: string;
  delegate_name: string;
  delegate_email: string;
  expires_at: string;
  note: string;
};

export type Member = {
  membership_id: string;
  user_id: string;
  email: string;
  full_name: string;
  role: Role;
  status: string;
  joined_at: string;
};

export type Invitation = {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
};

export type WebhookEndpoint = {
  id: string;
  url: string;
  events?: string[];
  status?: string;
  created_at?: string;
  description?: string;
};

export type WebhookDelivery = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  attempt_count: number;
  status: string;
  next_attempt_at?: string | null;
  last_http_status: number | null;
  last_error: string | null;
  created_at: string;
  endpoint_url?: string;
};

export type DerivedSignal = {
  code: string;
  description: string;
  observed: string;
  basis: string;
  severity: "info" | "warning" | "critical";
};

export type TimelineEvent = {
  id: string;
  label: string;
  timestamp: string | null;
  source: string;
  state: string;
  detail?: string;
};

export type RoutingAction = "prefer" | "review" | "hold";

export type RoutingRule = {
  id: string;
  label: string;
  currency: string;
  minMinor: number | null;
  maxMinor: number | null;
  country: string;
  action: RoutingAction;
  enabled: boolean;
};

export type ControlHealth = {
  open_reconciliation_exceptions?: number;
  pending_approvals?: number;
  open_periods?: number;
  payouts_awaiting_statement?: number;
  settlement_mode?: string;
};

export type ScenarioResult = {
  id?: string;
  title?: string;
  mode?: string;
  ledger_changed?: boolean;
  funds_moved?: boolean;
};

export type WorkspaceData = {
  organization: Organization | null;
  transactions: Transaction[];
  transactionCursor: string | null;
  transactionSummary: TransactionSummary[];
  transfers: Transfer[];
  fraudCases: FraudCase[];
  imports: ReconciliationImport[];
  policies: TransactionPolicy[];
};
