CREATE TABLE IF NOT EXISTS transaction_policies (
    organization_id text NOT NULL REFERENCES organizations(id),
    currency char(3) NOT NULL,
    max_single_minor bigint CHECK (max_single_minor IS NULL OR max_single_minor > 0),
    daily_collection_minor bigint CHECK (daily_collection_minor IS NULL OR daily_collection_minor > 0),
    daily_transfer_minor bigint CHECK (daily_transfer_minor IS NULL OR daily_transfer_minor > 0),
    approval_threshold_minor bigint CHECK (approval_threshold_minor IS NULL OR approval_threshold_minor > 0),
    updated_by text REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,currency)
);
