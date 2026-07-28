-- Migration 002: importer_metrics_mv materialized view (issue #251)
-- Down

DROP MATERIALIZED VIEW IF EXISTS importer_metrics_mv;
