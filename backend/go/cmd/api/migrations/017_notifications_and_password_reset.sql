-- Team chat notification channels (Slack, Microsoft Teams, Discord, Google
-- Chat). The incoming-webhook URL is a credential, so it is stored encrypted.
CREATE TABLE IF NOT EXISTS notification_channels (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 kind text NOT NULL CHECK (kind IN ('slack','teams','discord','google_chat')),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 url_ciphertext bytea NOT NULL,
 url_hint text NOT NULL,
 events jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
 last_delivered_at timestamptz,
 last_error text,
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id)
);
CREATE INDEX IF NOT EXISTS notification_channels_org_idx ON notification_channels(organization_id,status);

-- Each event is offered to chat channels once. Existing events are marked as
-- already notified so enabling channels does not replay history.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS notified_at timestamptz;
UPDATE outbox_events SET notified_at=now() WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_unnotified_idx ON outbox_events(created_at) WHERE notified_at IS NULL;

-- One-time password reset tokens (hashed), valid for one hour.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
 token_hash text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens(user_id,created_at DESC);
