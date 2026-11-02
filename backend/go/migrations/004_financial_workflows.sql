ALTER TABLE collections ADD COLUMN IF NOT EXISTS credited_account_id text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='collections_org_id_uq') THEN ALTER TABLE collections ADD CONSTRAINT collections_org_id_uq UNIQUE(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='collections_credit_account_org_fk') THEN ALTER TABLE collections ADD CONSTRAINT collections_credit_account_org_fk FOREIGN KEY (organization_id,credited_account_id) REFERENCES accounts(organization_id,id); END IF;
END $$;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id);
CREATE TABLE IF NOT EXISTS refunds (
 id text PRIMARY KEY, organization_id text NOT NULL, collection_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), currency char(3) NOT NULL,
 status text NOT NULL DEFAULT 'completed', reference text NOT NULL,
 created_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,reference),
 FOREIGN KEY (organization_id,collection_id) REFERENCES collections(organization_id,id)
);
CREATE TABLE IF NOT EXISTS transfer_approvals (
 id text PRIMARY KEY, organization_id text NOT NULL, transfer_id text NOT NULL,
 approver_user_id text NOT NULL REFERENCES users(id), decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,transfer_id),
 FOREIGN KEY (organization_id,transfer_id) REFERENCES transfers(organization_id,id)
);
CREATE TABLE IF NOT EXISTS risk_assessments (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 transaction_reference text NOT NULL, risk_score integer NOT NULL, risk_level text NOT NULL,
 decision text NOT NULL, model_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS fraud_cases (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 assessment_id text NOT NULL REFERENCES risk_assessments(id), status text NOT NULL DEFAULT 'open',
 priority text NOT NULL, assigned_to text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 FOREIGN KEY (organization_id,assessment_id) REFERENCES risk_assessments(organization_id,id)
);
CREATE TABLE IF NOT EXISTS reconciliation_imports (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 status text NOT NULL DEFAULT 'completed', source_name text NOT NULL DEFAULT 'sandbox-json',
 line_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reconciliation_lines (
 id bigserial PRIMARY KEY, import_id text NOT NULL REFERENCES reconciliation_imports(id),
 external_reference text NOT NULL, amount_minor bigint NOT NULL, currency char(3) NOT NULL,
 transaction_date timestamptz NOT NULL, match_status text NOT NULL DEFAULT 'unmatched'
);
CREATE INDEX IF NOT EXISTS risk_assessments_org_idx ON risk_assessments(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS fraud_cases_org_idx ON fraud_cases(organization_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS reconciliation_imports_org_idx ON reconciliation_imports(organization_id,created_at DESC);
