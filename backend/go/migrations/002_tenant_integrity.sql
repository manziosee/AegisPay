-- Upgrade databases created by the initial single-tenant schema. Every tenant
-- reference must match the parent row's organization, including ledger lines.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_org_id_uq') THEN ALTER TABLE customers ADD CONSTRAINT customers_org_id_uq UNIQUE (organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounts_org_id_uq') THEN ALTER TABLE accounts ADD CONSTRAINT accounts_org_id_uq UNIQUE (organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounts_customer_org_fk') THEN ALTER TABLE accounts ADD CONSTRAINT accounts_customer_org_fk FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='collections_customer_org_fk') THEN ALTER TABLE collections ADD CONSTRAINT collections_customer_org_fk FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transfers_source_org_fk') THEN ALTER TABLE transfers ADD CONSTRAINT transfers_source_org_fk FOREIGN KEY (organization_id,source_account_id) REFERENCES accounts(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transfers_destination_org_fk') THEN ALTER TABLE transfers ADD CONSTRAINT transfers_destination_org_fk FOREIGN KEY (organization_id,destination_account_id) REFERENCES accounts(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transfers_org_id_uq') THEN ALTER TABLE transfers ADD CONSTRAINT transfers_org_id_uq UNIQUE (organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='journal_entries_org_id_uq') THEN ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_org_id_uq UNIQUE (organization_id,id); END IF;
END $$;
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS organization_id text;
UPDATE journal_lines jl SET organization_id=je.organization_id FROM journal_entries je WHERE jl.journal_entry_id=je.id AND jl.organization_id IS NULL;
ALTER TABLE journal_lines ALTER COLUMN organization_id SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='journal_lines_entry_org_fk') THEN ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_entry_org_fk FOREIGN KEY (organization_id,journal_entry_id) REFERENCES journal_entries(organization_id,id); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='journal_lines_account_org_fk') THEN ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_account_org_fk FOREIGN KEY (organization_id,account_id) REFERENCES accounts(organization_id,id); END IF;
END $$;
