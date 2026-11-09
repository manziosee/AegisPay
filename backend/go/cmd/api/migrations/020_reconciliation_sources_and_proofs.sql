-- Which system a statement came from (bank, stripe, mpesa, flutterwave), so
-- every source can be reconciled and compared in one place.
ALTER TABLE reconciliation_imports ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'bank';

-- A likely match for a line that has no reference match. Only a suggestion:
-- a person must accept it, which records a manual resolution.
ALTER TABLE reconciliation_lines ADD COLUMN IF NOT EXISTS suggested_collection_id text;
ALTER TABLE reconciliation_lines ADD COLUMN IF NOT EXISTS suggestion_score integer;

-- Customers can be edited and archived; archived customers keep their history.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- One public timestamp per workspace per day: the audit chain's head hash,
-- stamped with OpenTimestamps so anyone can check the log was not rewritten
-- after that day.
CREATE TABLE IF NOT EXISTS audit_anchors (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 anchor_date date NOT NULL,
 head_hash text NOT NULL,
 last_entry_id text NOT NULL,
 entry_count bigint NOT NULL,
 statement text NOT NULL,
 digest text NOT NULL,
 proof bytea,
 calendars text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','stamped','failed')),
 error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id, anchor_date)
);
CREATE INDEX IF NOT EXISTS audit_anchors_org_idx ON audit_anchors(organization_id, anchor_date DESC);
