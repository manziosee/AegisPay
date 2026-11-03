-- Rejection reasons are recorded with each transfer review decision.
ALTER TABLE transfer_approvals ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

-- Retention sweeps delete by age; these keep them from scanning whole tables.
CREATE INDEX IF NOT EXISTS idempotency_records_created_idx ON idempotency_records(created_at);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);

-- Reconciliation looks up statement history and already-matched collections
-- by reference in bulk.
CREATE INDEX IF NOT EXISTS reconciliation_lines_reference_idx
 ON reconciliation_lines(organization_id,external_reference);
CREATE INDEX IF NOT EXISTS reconciliation_matched_collection_idx
 ON reconciliation_lines(organization_id,matched_collection_id)
 WHERE match_status='matched';
