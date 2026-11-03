ALTER TABLE transaction_policies
 ADD COLUMN IF NOT EXISTS required_approvals smallint NOT NULL DEFAULT 1
 CHECK (required_approvals BETWEEN 1 AND 3);

ALTER TABLE transfer_approvals
 DROP CONSTRAINT IF EXISTS transfer_approvals_organization_id_transfer_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS transfer_approvals_reviewer_uq
 ON transfer_approvals(organization_id,transfer_id,approver_user_id);

ALTER TABLE bank_payout_instructions
 ADD COLUMN IF NOT EXISTS required_approvals smallint NOT NULL DEFAULT 1;
ALTER TABLE bank_payout_instructions
 DROP CONSTRAINT IF EXISTS bank_payout_required_approvals_check;
ALTER TABLE bank_payout_instructions
 ADD CONSTRAINT bank_payout_required_approvals_check CHECK (required_approvals BETWEEN 1 AND 3);
ALTER TABLE bank_payout_instructions
 DROP CONSTRAINT IF EXISTS bank_payout_instructions_status_check;
ALTER TABLE bank_payout_instructions
 DROP CONSTRAINT IF EXISTS bank_payout_status_check;
ALTER TABLE bank_payout_instructions
 ADD CONSTRAINT bank_payout_status_check CHECK (status IN ('pending_approval','prepared','rejected','exported_for_manual_entry','submitted_to_bank','statement_confirmed','cancelled'));

CREATE TABLE IF NOT EXISTS bank_payout_approvals (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 payout_id text NOT NULL,
 approver_user_id text NOT NULL REFERENCES users(id),
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,payout_id,approver_user_id),
 FOREIGN KEY (organization_id,payout_id) REFERENCES bank_payout_instructions(organization_id,id)
);

CREATE TABLE IF NOT EXISTS approval_delegations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 delegator_user_id text NOT NULL REFERENCES users(id),
 delegate_user_id text NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 note text NOT NULL,
 created_by text NOT NULL REFERENCES users(id),
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (delegator_user_id <> delegate_user_id),
 UNIQUE (organization_id,id)
);
CREATE INDEX IF NOT EXISTS approval_delegations_active_idx
 ON approval_delegations(organization_id,delegate_user_id,expires_at)
 WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS bank_payout_approvals_payout_idx ON bank_payout_approvals(organization_id,payout_id,decision);
