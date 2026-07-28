# Runbook: High HTTP Request Latency (p95)

## Overview
This runbook covers how to respond to the `HttpRequestLatencyHighP95` alert. `http_request_duration_seconds` (labeled by `method`, `route`, `status_code`) is tracked on every request in `apps/api/src/index.ts`; a sustained rise in the 95th-percentile request duration means a meaningful share of users are experiencing slow responses, whether from a database bottleneck, a slow Soroban RPC call, or increased load.

## Alerting Symptoms
- **HttpRequestLatencyHighP95**: `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` has exceeded 1 second for 5 minutes.

---

## Step 1: Identify the Slow Route(s)

### Option A: Check Prometheus Metrics
Run the following query in your Prometheus console to see p95 latency broken down by route:
```promql
histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))
```

### Option B: Check OpenTelemetry Traces
Open Jaeger (see monitoring/README.md's "OpenTelemetry Distributed Tracing" section), select the `tariffshield-api` service, and sort traces by duration. The span tree shows exactly where the time is going: the Express handler itself, a `pg` query span, or a `soroban.rpc.<methodName>` span.

### Option C: Correlate with Database Slow Query Alerts
Check whether `DbSlowQueryRateHigh` or `DbCriticalSlowQuery` (monitoring/prometheus/alerts/database.yml) are also firing — see monitoring/runbooks/database-slow-queries.md. A database bottleneck is a common cause of elevated HTTP latency and should be ruled out first.

---

## Step 2: Common Causes and Remediation

- **Slow database queries**: See monitoring/runbooks/database-slow-queries.md — check `pg_stat_statements` for the top offenders.
- **Slow or rate-limited Soroban RPC calls**: Check the RPC provider's status and latency; consider whether a request is making more RPC calls than necessary.
- **Increased load**: Check `pg_pool_waiting` and overall request volume (`rate(http_requests_total[5m])`) — if load has genuinely increased, this may indicate a need to scale rather than a regression.
- **A specific route regressed**: If the slow route correlates with a recent deploy, check that commit's changes to the route handler.

---

## Step 3: Escalation Paths

Escalate to the on-call backend engineer if:
- Latency continues rising after ruling out database and Soroban RPC bottlenecks.
- The slow route is on a critical user-facing path (e.g. bond creation, payment) and is actively degrading the user experience.
- Latency correlates with a resource-exhaustion signal (CPU, memory, pool waiting) that suggests the service needs to be scaled.
