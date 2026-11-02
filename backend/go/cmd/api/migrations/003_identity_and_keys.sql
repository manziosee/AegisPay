CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 full_name text NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('owner','admin','finance_operator','fraud_analyst','developer','auditor')),
 status text NOT NULL DEFAULT 'active', joined_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,user_id)
);
CREATE TABLE IF NOT EXISTS user_sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), name text NOT NULL,
 key_prefix text NOT NULL UNIQUE, secret_hash text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','live')),
 scopes jsonb NOT NULL DEFAULT '[]'::jsonb, expires_at timestamptz, revoked_at timestamptz,
 created_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id,organization_id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON user_sessions(user_id,expires_at);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(organization_id,created_at DESC);
