ALTER TABLE reconciliation_lines ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE reconciliation_lines ADD COLUMN IF NOT EXISTS matched_collection_id text;
UPDATE reconciliation_lines l SET organization_id=i.organization_id FROM reconciliation_imports i WHERE i.id=l.import_id AND l.organization_id IS NULL;
ALTER TABLE reconciliation_lines ALTER COLUMN organization_id SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reconciliation_line_org_fk') THEN
  ALTER TABLE reconciliation_lines ADD CONSTRAINT reconciliation_line_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reconciliation_line_collection_org_fk') THEN
  ALTER TABLE reconciliation_lines ADD CONSTRAINT reconciliation_line_collection_org_fk FOREIGN KEY (organization_id,matched_collection_id) REFERENCES collections(organization_id,id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS reconciliation_reference_match_idx ON collections(organization_id,reference,status);
CREATE INDEX IF NOT EXISTS reconciliation_import_lines_idx ON reconciliation_lines(import_id,match_status,id);
