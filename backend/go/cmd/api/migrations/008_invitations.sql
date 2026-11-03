CREATE TABLE IF NOT EXISTS organization_invitations (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations(id),
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin','finance_operator','fraud_analyst','developer','auditor')),
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_by text REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitations_org_id_uq UNIQUE (organization_id,id)
);
CREATE INDEX IF NOT EXISTS invitations_pending_email_idx
    ON organization_invitations(lower(email),organization_id,expires_at)
    WHERE accepted_at IS NULL;
