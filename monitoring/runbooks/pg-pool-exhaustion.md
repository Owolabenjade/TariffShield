# Runbook: PostgreSQL Pool Exhaustion

## Overview
This runbook covers how to respond to the `PgPoolExhaustion` alert. `pg_pool_waiting` (`apps/api/src/db.ts`) is a gauge reading the `pg` connection pool's own `waitingCount` on every scrape; a sustained backlog of requests waiting for a client means the pool is saturated — either genuinely under more load than `PG_POOL_MAX` supports, or connections are being held open longer than expected by a slow or stuck query.

This alert mirrors an existing in-process check in `apps/api/src/db.ts` (`WAITING_ALERT_THRESHOLD=5`, `WAITING_ALERT_DURATION_MS=10s`) that only logs a Pino error and was never wired into Alertmanager. The two checks intentionally use the same threshold/duration through two different paths — a fast in-process log for local debugging, and this Alertmanager rule for paging — and should be kept in sync if either changes.

## Alerting Symptoms
- **PgPoolExhaustion**: More than 5 requests have been waiting for a PostgreSQL pool client for over 10 seconds.

---

## Step 1: Assess Pool Saturation

### Option A: Check Prometheus Metrics
Run the following queries in your Prometheus console:
```promql
pg_pool_active   # clients currently checked out
pg_pool_idle     # idle clients available for reuse
pg_pool_waiting  # requests queued waiting for a client
```
If `pg_pool_idle` is consistently 0 and `pg_pool_active` is at (or near) `PG_POOL_MAX`, the pool is genuinely saturated.

### Option B: Check Application Logs
Search Pino logs for the in-process warning this alert mirrors:
```
"PostgreSQL pool exhaustion: <N> requests waiting for >10s"
```
This confirms the condition was also observed locally by the API process, not just by the Prometheus scrape.

### Option C: Check for a Stuck or Slow Query
Cross-reference with `DbSlowQueryRateHigh`/`DbCriticalSlowQuery` (this same file) — a slow query holding a connection open is a common cause of pool exhaustion. See monitoring/runbooks/database-slow-queries.md and check `pg_stat_statements` / `pg_stat_activity` for long-running queries:
```sql
SELECT pid, now() - query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;
```

---

## Step 2: Remediation

- **Stuck query holding a connection**: Identify it via `pg_stat_activity` above and, if safe, terminate it: `SELECT pg_terminate_backend(<pid>);`
- **Genuine load increase**: If `pg_pool_active` is consistently near `PG_POOL_MAX` under normal query latency, consider raising `PG_POOL_MAX` (mind the database server's own `max_connections`).
- **Connection leak**: If waiting counts climb without a clear slow query, check recent code changes for a code path that acquires a client without releasing it back to the pool.

---

## Step 3: Escalation Paths

Escalate to the on-call backend engineer if:
- The waiting count continues climbing after terminating any stuck queries.
- Raising `PG_POOL_MAX` does not relieve the pressure (suggesting a leak, not a capacity issue).
- The exhaustion correlates with elevated HTTP latency or error rates (see monitoring/runbooks/http-latency.md and monitoring/runbooks/http-errors.md) — this is actively degrading the user-facing API.
