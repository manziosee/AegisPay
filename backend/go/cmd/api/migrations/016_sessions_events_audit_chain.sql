-- Session metadata shown in the "active sessions" list.
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip_address text NOT NULL DEFAULT '';
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Event log listing and test deliveries.
CREATE INDEX IF NOT EXISTS outbox_events_org_idx ON outbox_events(organization_id,created_at DESC,id DESC);

-- Tamper-evident audit log: each row stores the SHA-256 of the previous row's
-- hash plus its own content, per organization. Editing or deleting a row
-- breaks every later hash, and triggers refuse UPDATE and DELETE outright.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS seq bigserial;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash text;

CREATE OR REPLACE FUNCTION audit_log_hash(prev text, row_id text, org text, actor text, action text, resource_type text, resource_id text, metadata jsonb, created timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    prev || '|' || row_id || '|' || org || '|' || COALESCE(actor,'') || '|' || action || '|' ||
    resource_type || '|' || resource_id || '|' || metadata::text || '|' ||
    to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$$;

-- Chain existing rows in their original order.
DO $$
DECLARE
  r record;
  prev text;
  current_org text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_logs WHERE hash IS NULL ORDER BY organization_id, created_at, seq LOOP
    IF current_org IS DISTINCT FROM r.organization_id THEN
      current_org := r.organization_id;
      SELECT hash INTO prev FROM audit_logs WHERE organization_id=r.organization_id AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1;
      prev := COALESCE(prev, repeat('0', 64));
    END IF;
    UPDATE audit_logs SET prev_hash=prev,
      hash=audit_log_hash(prev, r.id, r.organization_id, r.actor_id, r.action, r.resource_type, r.resource_id, r.metadata, r.created_at)
      WHERE id=r.id RETURNING hash INTO prev;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  -- Serialize appends per organization so each row links to the latest one.
  PERFORM pg_advisory_xact_lock(hashtext('aegispay.audit:' || NEW.organization_id));
  SELECT hash INTO prev FROM audit_logs WHERE organization_id=NEW.organization_id ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := COALESCE(prev, repeat('0', 64));
  NEW.hash := audit_log_hash(NEW.prev_hash, NEW.id, NEW.organization_id, NEW.actor_id, NEW.action, NEW.resource_type, NEW.resource_id, NEW.metadata, NEW.created_at);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are append-only';
END $$;

DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs;
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE INDEX IF NOT EXISTS audit_logs_chain_idx ON audit_logs(organization_id,seq);
