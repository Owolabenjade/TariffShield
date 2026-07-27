-- Migration 005: GIN index on contract_events.raw JSONB (issue #238)
-- Up

CREATE INDEX IF NOT EXISTS idx_contract_events_raw_gin
  ON contract_events USING GIN (raw);
