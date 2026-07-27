-- Migration 004: soft-delete for importers (issue #237)
-- Down

DROP INDEX IF EXISTS idx_importers_deleted_at;
ALTER TABLE importers DROP COLUMN IF EXISTS deleted_at;
