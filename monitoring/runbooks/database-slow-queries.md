# Runbook: Database Slow Queries

## Overview
This runbook covers how to respond to the `DbSlowQueryRateHigh` and `DbCriticalSlowQuery` alerts. `db_query_duration_seconds` and `db_slow_queries_total` (labeled by `query_name`/`threshold`) are tracked on every database query; a sustained rate of slow (≥500ms) or any critically slow (≥2000ms) query indicates a performance regression, a missing index, lock contention, or a query operating on more data than expected.

## Alerting Symptoms
- **DbSlowQueryRateHigh**: More than 1 query per second at ≥500ms has been observed for 3 minutes (warning).
- **DbCriticalSlowQuery**: At least one query took ≥2000ms (critical, fires immediately).

---

## Step 1: Identify the Offending Query

### Option A: Check Prometheus Metrics
Run the following query in your Prometheus console to see which named queries are slow:
```promql
histogram_quantile(0.95, sum by (query_name, le) (rate(db_query_duration_seconds_bucket[5m])))
```

### Option B: Check the Slow Query Log
Queries taking ≥500ms emit a Pino `warn`, and ≥2000ms emit a Pino `error`, with:
```json
{ "query": "<sanitized SQL>", "durationMs": 612, "rowCount": 1, "caller": "select_importers" }
```
Search structured logs for these entries around the alert's firing time — `caller` identifies which code path issued the query.

### Option C: Check pg_stat_statements
See monitoring/README.md's "Top 10 slowest queries via pg_stat_statements" section (under "Database Query Performance") for the exact query and how to connect to the dev Postgres instance — that guidance is not duplicated here.

---

## Step 2: Common Causes and Remediation

- **Missing index**: Run `EXPLAIN ANALYZE` on the offending query (identified in Step 1) and check for a sequential scan on a large table where an index scan would be expected.
- **Lock contention**: Check `pg_stat_activity` for other queries holding locks on the same table:
  ```sql
  SELECT pid, state, wait_event_type, wait_event, query
  FROM pg_stat_activity
  WHERE wait_event_type = 'Lock';
  ```
- **Unbounded result set**: If the query lacks a `LIMIT` and the underlying table has grown, check whether pagination is missing from the calling code path (`caller` from the log entry).
- **Connection pool pressure amplifying latency**: Cross-reference with the `PgPoolExhaustion` alert (monitoring/prometheus/alerts/database.yml, monitoring/runbooks/pg-pool-exhaustion.md) — a saturated pool can make an otherwise-normal query appear slow simply from queueing time.

---

## Step 3: Escalation Paths

Escalate to the on-call backend engineer if:
- The slow query rate continues climbing after adding an index or fixing an identified query.
- A critical (≥2s) query is on a hot, user-facing path and is actively degrading the API (cross-reference `HttpRequestLatencyHighP95`, monitoring/runbooks/http-latency.md).
- `EXPLAIN ANALYZE` reveals a query plan that doesn't match expectations even after `ANALYZE`-ing the table (may indicate stale statistics or a Postgres configuration issue beyond the application layer).
