ALTER TABLE reconciliation_lines
    ADD COLUMN IF NOT EXISTS resolution_note text,
    ADD COLUMN IF NOT EXISTS resolved_by text REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
