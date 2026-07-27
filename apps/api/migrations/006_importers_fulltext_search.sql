-- Migration 006: full-text search on importers.legal_name (issue #239)
-- Up

ALTER TABLE importers ADD COLUMN IF NOT EXISTS legal_name_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(legal_name, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_importers_legal_name_tsv
  ON importers USING GIN (legal_name_tsv);
