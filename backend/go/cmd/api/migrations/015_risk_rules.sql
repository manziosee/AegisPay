-- Organization-defined risk rules evaluated before collections, transfers and
-- payouts are recorded. The strongest matching action wins:
-- block > review > allow.
CREATE TABLE IF NOT EXISTS risk_rules (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 enabled boolean NOT NULL DEFAULT true,
 priority integer NOT NULL DEFAULT 100,
 applies_to text[] NOT NULL CHECK (applies_to <@ ARRAY['collection','transfer','payout']::text[] AND cardinality(applies_to) > 0),
 currency char(3),
 min_amount_minor bigint CHECK (min_amount_minor IS NULL OR min_amount_minor > 0),
 max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor > 0),
 velocity_count integer CHECK (velocity_count IS NULL OR velocity_count > 0),
 velocity_window_minutes integer CHECK (velocity_window_minutes IS NULL OR velocity_window_minutes BETWEEN 1 AND 43200),
 action text NOT NULL CHECK (action IN ('allow','review','block')),
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 CHECK ((velocity_count IS NULL) = (velocity_window_minutes IS NULL))
);
CREATE INDEX IF NOT EXISTS risk_rules_org_idx ON risk_rules(organization_id,enabled,priority);

-- Link assessments to the record they were made for.
ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS subject_type text;
ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS matched_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS risk_assessments_subject_idx ON risk_assessments(organization_id,subject_type,subject_id);

-- Velocity checks count recent records per customer and per source account.
CREATE INDEX IF NOT EXISTS collections_customer_recent_idx ON collections(organization_id,customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_source_recent_idx ON transfers(organization_id,source_account_id,created_at DESC);
