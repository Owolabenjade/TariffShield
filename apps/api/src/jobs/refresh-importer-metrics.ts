// Scheduled refresh for importer_metrics_mv (issue #251).
//
// Keeps the surety-dashboard aggregate statistics materialized view current
// without blocking concurrent reads (REFRESH ... CONCURRENTLY). Runs on a
// fixed interval rather than pg-cron so it doesn't require extra database
// privileges/extensions beyond what migrate() already sets up.
import client from "prom-client";
import { pino } from "pino";
import { refreshImporterMetrics } from "../db.js";

const logger = pino({ name: "importer-metrics-refresh" });

const refreshRunsCounter = new client.Counter({
  name: "importer_metrics_refresh_runs_total",
  help: "Total number of importer_metrics_mv refresh attempts",
  labelNames: ["outcome"],
});

const refreshDurationSeconds = new client.Histogram({
  name: "importer_metrics_refresh_duration_seconds",
  help: "Duration of importer_metrics_mv refreshes in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

async function runRefresh(): Promise<void> {
  const endTimer = refreshDurationSeconds.startTimer();
  try {
    await refreshImporterMetrics();
    endTimer();
    refreshRunsCounter.inc({ outcome: "success" });
  } catch (err) {
    endTimer();
    refreshRunsCounter.inc({ outcome: "failure" });
    // Logged (and counted, for alerting on the `outcome="failure"` series)
    // rather than thrown — a stale view is a degraded state, not a reason
    // to crash the API process.
    logger.error({ err }, "importer_metrics_mv refresh failed");
  }
}

export function startImporterMetricsScheduler(): void {
  setInterval(() => {
    runRefresh().catch((err) => logger.error({ err }, "importer_metrics_mv refresh tick error"));
  }, REFRESH_INTERVAL_MS);

  // Prime the view once at boot so early dashboard loads aren't served
  // whatever the migration's initial CREATE snapshot happened to compute.
  runRefresh().catch((err) => logger.error({ err }, "initial importer_metrics_mv refresh failed"));

  logger.info({ intervalMs: REFRESH_INTERVAL_MS }, "importer-metrics refresh scheduler started");
}
