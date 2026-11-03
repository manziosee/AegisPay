ALTER TABLE reconciliation_lines
    ADD COLUMN IF NOT EXISTS provider_fee_minor bigint NOT NULL DEFAULT 0
    CHECK (provider_fee_minor >= 0);
