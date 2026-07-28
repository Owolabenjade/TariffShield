# Runbook: Importer Metrics Refresh Job Failures

## Overview
This runbook covers how to respond to `ImporterMetricsRefreshJobNotRunning` and `ImporterMetricsRefreshJobFailing` alerts. The scheduled job in `apps/api/src/jobs/refresh-importer-metrics.ts` runs `REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics_mv` every 5 minutes so the surety-dashboard aggregate statistics stay current without blocking concurrent reads.

## Alerting Symptoms
- **ImporterMetricsRefreshJobNotRunning**: No refresh attempts (success or failure) have been recorded in the last 15 minutes — the scheduler itself may be down, or the API process has crashed/restarted without the interval re-registering.
- **ImporterMetricsRefreshJobFailing**: Refresh attempts are running but consistently completing with `outcome="failure"` — `importer_metrics_mv` is now stale and the dashboard is serving outdated aggregate statistics.

---

## Step 1: Diagnose Current State

### Option A: Check Prometheus Metrics
```promql
rate(importer_metrics_refresh_runs_total[15m])
```
A value of `0` confirms the job has stopped running entirely. Break down by `outcome` to see the success/failure split:
```promql
sum by (outcome) (rate(importer_metrics_refresh_runs_total[15m]))
```

### Option B: Check Application Logs
The job logs under the `importer-metrics-refresh` Pino logger name. Search for:
- `"importer_metrics_mv refresh failed"` — a single failed attempt, with the underlying `err` field.
- `"importer-metrics refresh scheduler started"` — confirms the scheduler booted; its absence since the last deploy/restart means `startImporterMetricsScheduler()` was never called.

### Option C: Check the View Directly
```sql
SELECT * FROM importer_metrics_mv WHERE singleton_id = 1;
```
Compare against a fresh aggregate query over the underlying `importers` table to see how stale the view is.

---

## Step 2: Remediate

1. **If the scheduler stopped (`ImporterMetricsRefreshJobNotRunning`)**: Restart the API process. The scheduler primes the view once at boot and then re-registers its 5-minute interval, so a clean restart is usually sufficient.
2. **If refreshes are failing (`ImporterMetricsRefreshJobFailing`)**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires the unique index `idx_importer_metrics_mv_singleton` to exist and requires no other long-running transaction to hold a conflicting lock on the view. Check for:
   ```sql
   SELECT pid, state, query, now() - query_start AS duration
   FROM pg_stat_activity
   WHERE query ILIKE '%importer_metrics_mv%' AND state != 'idle';
   ```
   A stuck or long-running refresh will block subsequent attempts.
3. **Manual refresh**: If the automated job is unhealthy but you need current data immediately:
   ```sql
   REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics_mv;
   ```

---

## Step 3: Escalation Paths

Escalate to the On-Call DevOps or Lead Backend Engineer if:
- A manual `REFRESH MATERIALIZED VIEW CONCURRENTLY` also fails — this usually indicates the underlying `importers` table or its indexes are corrupted, or a schema drift has broken the view definition (see `apps/api/migrations/002_importer_metrics_mv.sql`).
- The refresh job is running successfully but `importer_metrics_mv` still reflects stale data — check the view's `WHERE singleton_id = 1` assumption isn't violated by duplicate rows.
