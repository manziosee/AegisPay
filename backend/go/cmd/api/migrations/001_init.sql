CREATE TABLE IF NOT EXISTS organizations (
 id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
 country_code char(2) NOT NULL DEFAULT 'RW', status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL, email text, phone text, status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id,email), CONSTRAINT customers_org_id_uq UNIQUE (organization_id,id)
);
CREATE TABLE IF NOT EXISTS accounts (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 customer_id text, currency char(3) NOT NULL,
 account_type text NOT NULL DEFAULT 'wallet', status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT accounts_org_id_uq UNIQUE (organization_id,id),
 CONSTRAINT accounts_customer_org_fk FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE TABLE IF NOT EXISTS collections (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 customer_id text, amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 currency char(3) NOT NULL, status text NOT NULL DEFAULT 'pending', description text NOT NULL DEFAULT '',
 reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,reference),
 CONSTRAINT collections_customer_org_fk FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE TABLE IF NOT EXISTS transfers (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 source_account_id text NOT NULL, destination_account_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL,
 status text NOT NULL DEFAULT 'completed', reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,reference), CONSTRAINT transfers_org_id_uq UNIQUE(organization_id,id), CHECK(source_account_id <> destination_account_id),
 CONSTRAINT transfers_source_org_fk FOREIGN KEY (organization_id,source_account_id) REFERENCES accounts(organization_id,id),
 CONSTRAINT transfers_destination_org_fk FOREIGN KEY (organization_id,destination_account_id) REFERENCES accounts(organization_id,id)
);
CREATE TABLE IF NOT EXISTS journal_entries (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 reference_type text NOT NULL, reference_id text NOT NULL, currency char(3) NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT journal_entries_org_id_uq UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS journal_lines (
 id bigserial PRIMARY KEY, organization_id text NOT NULL, journal_entry_id text NOT NULL,
 account_id text NOT NULL, side text NOT NULL CHECK(side IN ('debit','credit')),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT journal_lines_entry_org_fk FOREIGN KEY (organization_id,journal_entry_id) REFERENCES journal_entries(organization_id,id),
 CONSTRAINT journal_lines_account_org_fk FOREIGN KEY (organization_id,account_id) REFERENCES accounts(organization_id,id)
);
CREATE TABLE IF NOT EXISTS idempotency_records (
 organization_id text NOT NULL REFERENCES organizations(id), idempotency_key text NOT NULL,
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS outbox_events (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 aggregate_type text NOT NULL, aggregate_id text NOT NULL, event_type text NOT NULL,
 payload jsonb NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_org_idx ON customers(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS accounts_org_idx ON accounts(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS collections_org_idx ON collections(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_org_idx ON transfers(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;
