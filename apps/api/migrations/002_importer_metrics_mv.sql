-- Migration 002: importer_metrics_mv materialized view (issue #251)
-- Up
--
-- Pre-computes surety-dashboard aggregate statistics so they can be served
-- in <5ms instead of running live GROUP BY / full-table-scan queries against
-- importers/bond_records/contract_events on every page load.
--
-- Metric definitions (chosen to match existing conventions elsewhere in the
-- codebase, e.g. apps/api/src/routes/regulatory.ts and compliance.ts):
--   total_importers    - COUNT(*) of registered importers
--   total_bond_value   - SUM(bond_records.bond_amount): the bonds' face value
--   avg_balance        - AVG(importers.collateral_balance): average posted collateral
--   compliance_rate    - % of bond_records where bond_amount >= cbp_minimum_required
--                         (mirrors compliance.ts's existing "bond_amount < cbp_minimum_required"
--                         under-collateralization check, inverted to a rate)
--   topup_count_30d    - count of deposit/auto-top-up contract_events in the last 30 days

CREATE MATERIALIZED VIEW IF NOT EXISTS importer_metrics_mv AS
SELECT
  1 AS singleton_id,
  (SELECT COUNT(*) FROM importers) AS total_importers,
  (SELECT COALESCE(SUM(bond_amount), 0) FROM bond_records) AS total_bond_value,
  -- ROUND to a whole stroop count: the frontend feeds this through
  -- stroopsToXlm(), which does BigInt(value) and would throw on a
  -- fractional string like the raw AVG() output.
  (SELECT ROUND(COALESCE(AVG(collateral_balance), 0)) FROM importers) AS avg_balance,
  (
    SELECT CASE WHEN COUNT(*) = 0 THEN 100.0
      ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE bond_amount >= cbp_minimum_required) / COUNT(*), 2)
    END
    FROM bond_records
  ) AS compliance_rate,
  (
    SELECT COUNT(*) FROM contract_events
    WHERE kind IN ('deposit_collateral', 'deposit_reserve', 'auto_top_up')
      AND created_at >= now() - INTERVAL '30 days'
  ) AS topup_count_30d,
  now() AS refreshed_at;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index over real
-- (non-expression) columns. The view has exactly one row, so a constant
-- `singleton_id` column plus a plain unique index on it satisfies that
-- requirement while still enabling concurrent (non-blocking-reads) refresh.
CREATE UNIQUE INDEX IF NOT EXISTS idx_importer_metrics_mv_singleton
  ON importer_metrics_mv (singleton_id);
