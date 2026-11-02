DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='outbox_org_id_uq') THEN ALTER TABLE outbox_events ADD CONSTRAINT outbox_org_id_uq UNIQUE(organization_id,id); END IF;
END $$;
CREATE TABLE IF NOT EXISTS webhook_endpoints (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 url text NOT NULL, secret_ciphertext bytea NOT NULL, events jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT webhook_endpoints_org_id_uq UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
 id text PRIMARY KEY, organization_id text NOT NULL,
 endpoint_id text NOT NULL, event_id text NOT NULL, event_type text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'queued',
 next_attempt_at timestamptz NOT NULL DEFAULT now(), last_http_status integer,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,endpoint_id,event_id),
 FOREIGN KEY (organization_id,endpoint_id) REFERENCES webhook_endpoints(organization_id,id),
 FOREIGN KEY (organization_id,event_id) REFERENCES outbox_events(organization_id,id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 actor_id text, action text NOT NULL, resource_type text NOT NULL,
 resource_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fraud_case_notes (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 case_id text NOT NULL REFERENCES fraud_cases(id), author_id text REFERENCES users(id),
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due_idx ON webhook_deliveries(next_attempt_at) WHERE status IN ('queued','retrying');
CREATE INDEX IF NOT EXISTS audit_logs_org_idx ON audit_logs(organization_id,created_at DESC);
