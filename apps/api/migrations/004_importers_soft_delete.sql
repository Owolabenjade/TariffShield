-- Migration 004: soft-delete for importers table (issue #237)
-- Up

ALTER TABLE importers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX idx_importers_deleted_at ON importers(deleted_at) WHERE deleted_at IS NULL;
