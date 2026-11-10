CREATE TABLE IF NOT EXISTS finance_funds (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL,
 fund_type text NOT NULL CHECK (fund_type IN ('general','restricted','grant','project','household')),
 donor_name text NOT NULL DEFAULT '',
 project_code text NOT NULL DEFAULT '',
 restriction_note text NOT NULL DEFAULT '',
 currency char(3) NOT NULL,
 allocated_minor bigint NOT NULL CHECK (allocated_minor >= 0),
 period_start date,
 period_end date,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (period_start IS NULL OR period_end IS NULL OR period_start < period_end),
 UNIQUE (organization_id,id)
);

CREATE TABLE IF NOT EXISTS finance_commitments (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 fund_id text NOT NULL,
 commitment_type text NOT NULL CHECK (commitment_type IN ('supplier','operating','staff_advance')),
 title text NOT NULL,
 beneficiary_name text NOT NULL DEFAULT '',
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency char(3) NOT NULL,
 due_date date,
 status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','linked','settled','cancelled')),
 payout_id text,
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 FOREIGN KEY (organization_id,fund_id) REFERENCES finance_funds(organization_id,id),
 FOREIGN KEY (organization_id,payout_id) REFERENCES bank_payout_instructions(organization_id,id)
);

ALTER TABLE bank_payout_instructions
 ADD COLUMN IF NOT EXISTS finance_commitment_id text;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bank_payout_finance_commitment_fk') THEN
  ALTER TABLE bank_payout_instructions ADD CONSTRAINT bank_payout_finance_commitment_fk
   FOREIGN KEY (organization_id,finance_commitment_id) REFERENCES finance_commitments(organization_id,id);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_advances (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 commitment_id text NOT NULL,
 payout_id text NOT NULL,
 staff_name text NOT NULL,
 purpose text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency char(3) NOT NULL,
 status text NOT NULL DEFAULT 'awaiting_payout' CHECK (status IN ('awaiting_payout','outstanding','settled')),
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 UNIQUE (organization_id,commitment_id),
 UNIQUE (organization_id,payout_id),
 FOREIGN KEY (organization_id,commitment_id) REFERENCES finance_commitments(organization_id,id),
 FOREIGN KEY (organization_id,payout_id) REFERENCES bank_payout_instructions(organization_id,id)
);

CREATE TABLE IF NOT EXISTS advance_settlements (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 advance_id text NOT NULL,
 used_minor bigint NOT NULL CHECK (used_minor >= 0),
 returned_minor bigint NOT NULL CHECK (returned_minor >= 0),
 note text NOT NULL,
 status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected')),
 submitted_by text NOT NULL REFERENCES users(id),
 reviewed_by text REFERENCES users(id),
 reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (used_minor + returned_minor > 0),
 UNIQUE (organization_id,id),
 FOREIGN KEY (organization_id,advance_id) REFERENCES staff_advances(organization_id,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS advance_settlements_one_pending_idx
 ON advance_settlements(organization_id,advance_id) WHERE status='pending_review';

CREATE TABLE IF NOT EXISTS finance_evidence (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 resource_type text NOT NULL CHECK (resource_type IN ('commitment','advance','settlement')),
 resource_id text NOT NULL,
 file_name text NOT NULL,
 content_type text NOT NULL,
 file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 4194304),
 sha256 text NOT NULL,
 content bytea NOT NULL,
 note text NOT NULL DEFAULT '',
 uploaded_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 UNIQUE (organization_id,resource_type,resource_id,sha256)
);

CREATE INDEX IF NOT EXISTS finance_funds_org_idx ON finance_funds(organization_id,status,name);
CREATE INDEX IF NOT EXISTS finance_commitments_fund_idx ON finance_commitments(organization_id,fund_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS staff_advances_org_idx ON staff_advances(organization_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS advance_settlements_org_idx ON advance_settlements(organization_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS finance_evidence_resource_idx ON finance_evidence(organization_id,resource_type,resource_id,created_at DESC);
