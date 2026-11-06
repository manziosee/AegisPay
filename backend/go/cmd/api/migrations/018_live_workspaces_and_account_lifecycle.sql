-- A workspace is either practice ('sandbox': simulated money, safe to explore)
-- or live ('live': money is only confirmed by bank statements or connectors).
-- Existing workspaces were created as sandboxes and stay that way.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','live'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sample_data_loaded_at timestamptz;

-- Accounts created before verification existed are treated as verified; new
-- ones must confirm their address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
UPDATE users SET email_verified_at=now() WHERE email_verified_at IS NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
 token_hash text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verification_user_idx ON email_verification_tokens(user_id,created_at DESC);
