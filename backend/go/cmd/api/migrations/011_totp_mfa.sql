CREATE TABLE IF NOT EXISTS user_mfa_factors (
    user_id text PRIMARY KEY REFERENCES users(id),
    secret_ciphertext bytea NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    enabled_at timestamptz
);
CREATE TABLE IF NOT EXISTS mfa_login_challenges (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    organization_id text NOT NULL REFERENCES organizations(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_challenge_expiry_idx ON mfa_login_challenges(expires_at);
