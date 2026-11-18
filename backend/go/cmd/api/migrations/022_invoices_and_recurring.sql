-- Invoices are payment requests with a customer, a number, line items and
-- tax, so they keep matching against bank and provider statements.
ALTER TABLE bank_payment_requests
 ADD COLUMN IF NOT EXISTS customer_id text,
 ADD COLUMN IF NOT EXISTS invoice_number text,
 ADD COLUMN IF NOT EXISTS line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN IF NOT EXISTS tax_rate_bps integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS tax_minor bigint NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '',
 -- An unguessable link the customer opens without signing in. It shows the
 -- invoice and how to pay; it grants nothing else.
 ADD COLUMN IF NOT EXISTS share_token text,
 ADD COLUMN IF NOT EXISTS recurring_id text,
 ADD COLUMN IF NOT EXISTS sent_at timestamptz,
 ADD COLUMN IF NOT EXISTS paid_at timestamptz,
 ADD COLUMN IF NOT EXISTS paid_note text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bank_payment_requests_tax_check') THEN
  ALTER TABLE bank_payment_requests ADD CONSTRAINT bank_payment_requests_tax_check CHECK (tax_rate_bps BETWEEN 0 AND 10000 AND tax_minor >= 0);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bank_payment_requests_customer_fk') THEN
  ALTER TABLE bank_payment_requests ADD CONSTRAINT bank_payment_requests_customer_fk
   FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id);
 END IF;
END $$;

-- Cash, cheque or anything that never shows up on a statement can be marked
-- paid by hand, with a note.
ALTER TABLE bank_payment_requests DROP CONSTRAINT IF EXISTS bank_payment_requests_status_check;
ALTER TABLE bank_payment_requests ADD CONSTRAINT bank_payment_requests_status_check
 CHECK (status IN ('open','statement_confirmed','marked_paid','cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS bank_payment_requests_share_token_uq ON bank_payment_requests(share_token) WHERE share_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bank_payment_requests_invoice_number_uq ON bank_payment_requests(organization_id,invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_payment_requests_customer_idx ON bank_payment_requests(organization_id,customer_id,created_at DESC);

ALTER TABLE organizations
 ADD COLUMN IF NOT EXISTS payment_instructions text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS invoice_footer text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS invoice_reminders boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS invoice_next_number integer NOT NULL DEFAULT 1;

-- Invoices issued on a schedule: rent, membership dues, retainers, fees.
CREATE TABLE IF NOT EXISTS recurring_invoices (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 customer_id text NOT NULL,
 currency char(3) NOT NULL,
 line_items jsonb NOT NULL,
 tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
 notes text NOT NULL DEFAULT '',
 frequency text NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
 due_days integer NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 0 AND 365),
 next_run_on date NOT NULL,
 -- The day of the month the schedule started on, so the 31st stays the
 -- last day of shorter months instead of drifting.
 anchor_day integer NOT NULL DEFAULT 1 CHECK (anchor_day BETWEEN 1 AND 31),
 end_on date,
 auto_send boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
 issued_count integer NOT NULL DEFAULT 0,
 last_issued_at timestamptz,
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id,id),
 FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE INDEX IF NOT EXISTS recurring_invoices_due_idx ON recurring_invoices(next_run_on) WHERE status='active';
