-- Migration 006: full-text search on importers.legal_name (issue #239)
-- Down

DROP INDEX IF EXISTS idx_importers_legal_name_tsv;
ALTER TABLE importers DROP COLUMN IF EXISTS legal_name_tsv;
