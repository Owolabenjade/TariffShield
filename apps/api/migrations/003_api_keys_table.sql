-- Migration 003: api_keys table for webhook consumer credentials (issue #236)
-- Up

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  label        TEXT,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_prefix  ON api_keys(prefix);

-- Only one active (non-revoked) key per prefix per user
CREATE UNIQUE INDEX idx_api_keys_user_prefix_active
  ON api_keys(user_id, prefix)
  WHERE revoked_at IS NULL;
