-- Business-readable account labels. The ledger identity stays the account id;
-- the label is presentation only and never changes postings.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS label text;
