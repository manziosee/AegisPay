ALTER TABLE organizations
 ADD COLUMN IF NOT EXISTS workspace_type text NOT NULL DEFAULT 'business'
 CHECK (workspace_type IN ('personal','business'));

CREATE TABLE IF NOT EXISTS bank_payment_requests (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency char(3) NOT NULL,
 reference text NOT NULL,
 description text NOT NULL DEFAULT '',
 due_date date,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','statement_confirmed','cancelled')),
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 UNIQUE (organization_id,reference)
);

CREATE TABLE IF NOT EXISTS bank_payout_instructions (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 beneficiary_name text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency char(3) NOT NULL,
 reference text NOT NULL,
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','exported_for_manual_entry','submitted_to_bank','statement_confirmed','cancelled')),
 created_by text REFERENCES users(id),
 submitted_by text REFERENCES users(id),
 submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 UNIQUE (organization_id,reference)
);

ALTER TABLE reconciliation_lines
 ADD COLUMN IF NOT EXISTS matched_request_id text,
 ADD COLUMN IF NOT EXISTS matched_payout_id text,
 ADD COLUMN IF NOT EXISTS duplicate_of bigint,
 ADD COLUMN IF NOT EXISTS suggestion_reason text NOT NULL DEFAULT '';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reconciliation_line_request_fk') THEN
  ALTER TABLE reconciliation_lines ADD CONSTRAINT reconciliation_line_request_fk
   FOREIGN KEY (organization_id,matched_request_id) REFERENCES bank_payment_requests(organization_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reconciliation_line_payout_fk') THEN
  ALTER TABLE reconciliation_lines ADD CONSTRAINT reconciliation_line_payout_fk
   FOREIGN KEY (organization_id,matched_payout_id) REFERENCES bank_payout_instructions(organization_id,id);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS close_periods (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 period_start date NOT NULL,
 period_end date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
 created_by text REFERENCES users(id),
 closed_by text REFERENCES users(id),
 closed_at timestamptz,
 close_note text NOT NULL DEFAULT '',
 reopened_by text REFERENCES users(id),
 reopened_at timestamptz,
 reopen_note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (period_start < period_end),
 UNIQUE (organization_id,id),
 UNIQUE (organization_id,period_start,period_end)
);

CREATE TABLE IF NOT EXISTS scenario_runs (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 scenario_type text NOT NULL CHECK (scenario_type IN ('duplicate_statement_lines','mismatched_totals','suspicious_transfer')),
 result jsonb NOT NULL,
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_payment_requests_org_idx ON bank_payment_requests(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS bank_payout_instructions_org_idx ON bank_payout_instructions(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS close_periods_org_idx ON close_periods(organization_id,period_start DESC);
CREATE INDEX IF NOT EXISTS scenario_runs_org_idx ON scenario_runs(organization_id,created_at DESC);
