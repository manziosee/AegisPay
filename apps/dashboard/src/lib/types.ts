export type Role =
  | "owner"
  | "admin"
  | "finance_operator"
  | "fraud_analyst"
  | "developer"
  | "auditor";

export type WorkspaceType = "personal" | "business";

/** sandbox: practice with simulated money. live: confirmed by bank statements. */
export type WorkspaceEnvironment = "sandbox" | "live";

/** Signed-in user profile. The bearer token stays in an httpOnly cookie. */
export type Session = {
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
  full_name?: string;
  email?: string;
  email_verified?: boolean;
  expires_at?: string;
};

export type Organization = {
  id: string;
  name: string;
  workspace_type: WorkspaceType;
  environment?: WorkspaceEnvironment;
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
  model_version?: string;
  currency?: string;
  amount_minor?: number;
};

export type FraudCaseNote = {
  id: string;
  note: string;
  created_at: string;
  author_id: string | null;
  author_name: string;
};

export type FraudCaseDetail = FraudCase & { notes: FraudCaseNote[] };

export type RiskDecision = "allow" | "review" | "block";

export type FraudAssessment = {
  id: string;
  transaction_reference: string;
  risk_score: number;
  risk_level: string;
  decision: RiskDecision;
  model_version: string;
  matched_rules?: { id: string; name: string; action: string; reason: string }[];
  case_id: string | null;
};

export type ReconciliationImport = {
  id: string;
  status: string;
  source_name: string;
  provider?: string;
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
  suggested_collection_id?: string | null;
  suggestion_score?: number | null;
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
  label?: string | null;
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
  created_at?: string;
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

export type WorkspaceMembership = {
  id: string;
  name: string;
  workspace_type: WorkspaceType;
  environment?: WorkspaceEnvironment;
  country_code: string;
  role: Role;
  joined_at: string;
  current: boolean;
};

export type Customer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
};

export type CustomerDetail = Customer & {
  accounts: { id: string; currency: string; account_type: string; status: string; label: string | null; balance_minor: number }[];
  collection_totals: { currency: string; status: string; count: number; amount_minor: number }[];
  recent_collections: { id: string; reference: string; amount: number; currency: string; status: string; created_at: string }[];
};

export type ActivityReport = {
  currency: string;
  days: number;
  series: { date: string; money_in: number; money_out: number }[];
  total_in: number;
  total_out: number;
  balances: { currency: string; balance_minor: number }[];
  collections_by_status: { status: string; count: number; amount_minor: number }[];
};

export type CashForecast = {
  currency: string;
  balance_minor: number;
  horizon_days: number;
  average_daily_in: number;
  average_daily_out: number;
  expected_in: number;
  expected_out: number;
  runway_days: number | null;
  history: { date: string; balance: number }[];
  projection: { date: string; known: number; typical: number }[];
  expected: { kind: "payment_request" | "collection" | "payout"; id: string; reference: string; amount_minor: number; expected_on: string; overdue: boolean }[];
  balances: { currency: string; balance_minor: number }[];
  note: string;
};

export type AuditAnchor = {
  date: string;
  head_hash: string;
  last_entry_id: string;
  entry_count: number;
  digest: string;
  status: "pending" | "stamped" | "failed";
  calendars: string[];
  created_at: string;
};

export type ReconciliationSource = {
  provider: string;
  currency: string;
  import_count: number;
  line_count: number;
  matched_count: number;
  open_count: number;
  matched_amount: number;
  open_amount: number;
  provider_fees: number;
  suggested_count: number;
  last_import_at: string;
};

export type RiskRuleTemplate = {
  id: string;
  name: string;
  description: string;
  currency: string;
  rules: { name: string; applies_to: string[]; action: string; currency: string | null; min_amount_minor: number | null; velocity_count: number | null; velocity_window_minutes: number | null }[];
};

export type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  environment: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

/** Returned once when a key is created or rotated. */
export type ApiKeySecret = {
  id: string;
  name: string;
  secret: string;
  scopes: string[];
  expires_at: string | null;
  replaces?: string;
};

export type MfaStatus = { enabled: boolean; method: "totp"; enabled_at: string | null };

export type MfaEnrollment = { status: string; secret: string; otpauth_uri: string };

export type RiskSubjectKind = "collection" | "transfer" | "payout";
export type RiskAction = "allow" | "review" | "block";

export type RiskRule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  applies_to: RiskSubjectKind[];
  currency: string | null;
  min_amount_minor: number | null;
  max_amount_minor: number | null;
  velocity_count: number | null;
  velocity_window_minutes: number | null;
  action: RiskAction;
  created_at: string;
  updated_at: string;
};

export type RiskMatch = { id: string; name: string; action: RiskAction; reason: string };

export type RiskEvaluation = { decision: RiskAction; matched_rules: RiskMatch[] };

export type EventRecord = {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  data: Record<string, unknown>;
  created_at: string;
  published_at: string | null;
  deliveries: number;
  delivered: number;
};

export type UserSession = {
  id: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  current: boolean;
};

export type AuditVerification = {
  valid: boolean;
  checked: number;
  anchors_checked?: number;
  head_hash?: string;
  first_invalid_id?: string;
  detail?: string;
};
