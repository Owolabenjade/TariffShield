# Runbook: Elevated HTTP 5xx Error Rate

## Overview
This runbook covers how to respond to the `HttpServerErrorRateHigh` alert. `http_requests_total` (labeled by `method`, `route`, `status_code`) is tracked on every request in `apps/api/src/index.ts`; a sustained spike in `5xx` responses indicates the API is failing requests, whether from an unhandled exception, a downstream dependency outage (PostgreSQL, Soroban RPC), or a bad deploy.

## Alerting Symptoms
- **HttpServerErrorRateHigh**: The rate of HTTP 5xx responses has exceeded 0.05/s for 5 minutes.

---

## Step 1: Identify the Failing Route(s)

### Option A: Check Prometheus Metrics
Run the following query in your Prometheus console to see which routes are producing 5xx responses:
```promql
sum by (route, status_code) (rate(http_requests_total{status_code=~"5.."}[5m]))
```

### Option B: Check OpenTelemetry Traces
Open Jaeger (see monitoring/README.md's "OpenTelemetry Distributed Tracing" section) and search for `tariffshield-api` traces with an error status. The span tree shows exactly which downstream call (PostgreSQL query, Soroban RPC) failed.

### Option C: Check Application Logs
Search structured Pino logs for `"level":"error"` entries around the alert's firing time. Correlate with `trace_id` from Jaeger if a specific request needs deeper investigation.

---

## Step 2: Common Causes and Remediation

- **Database outage or connection exhaustion**: Check `pg_pool_waiting` and the `DbSlowQueryRateHigh`/`DbCriticalSlowQuery` alerts (see monitoring/runbooks/database-slow-queries.md) — pool exhaustion surfaces as request timeouts/errors here too.
- **Soroban RPC outage**: Check the RPC provider's status page; the API's `/health` endpoint reports Soroban RPC connectivity.
- **Bad deploy**: If the spike started immediately after a deploy, check recent commits to the failing route(s) and consider rolling back.
- **Unhandled exception in a new code path**: Search logs for a stack trace; file a fix and monitor the error rate after deploying it.

---

## Step 3: Escalation Paths

Escalate to the on-call backend engineer if:
- The error rate continues climbing after ruling out database and Soroban RPC issues.
- A rollback does not reduce the error rate (indicating the cause is external, not the API's own code).
- The error correlates with a security event (unexpected traffic pattern, potential attack) — loop in security/on-call lead immediately.
