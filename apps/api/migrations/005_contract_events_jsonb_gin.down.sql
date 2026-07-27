-- Migration 005: GIN index on contract_events.raw (issue #238)
-- Down

DROP INDEX IF EXISTS idx_contract_events_raw_gin;
