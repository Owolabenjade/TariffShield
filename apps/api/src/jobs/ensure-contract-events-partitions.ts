// #228 — keeps upcoming contract_events monthly partitions pre-created.
//
// The 0002_partition_contract_events migration pre-creates a lookahead
// buffer of future months at cutover time, but that buffer is fixed at
// migration time and doesn't grow on its own. This job tops it back up on
// an interval, same rationale as jobs/refresh-importer-metrics.ts: it runs
// as an application-level timer rather than a pg_cron job so it doesn't
// require the pg_cron extension or superuser-managed cluster configuration
// — it only needs the same DB privileges the app already has.
//
// A missing future partition degrades gracefully rather than failing
// writes: contract_events has a DEFAULT partition (see the migration) that
// catches any row whose created_at doesn't match a declared range, so this
// job falling behind delays partition pruning for that month rather than
// causing insert errors.
import client from "prom-client";
import { pino } from "pino";
import { pool } from "../db.js";
import { monthRange, createContractEventsPartition } from "../lib/contract-events-partitions.js";

const logger = pino({ name: "contract-events-partition-scheduler" });

const partitionEnsureRunsCounter = new client.Counter({
  name: "contract_events_partition_ensure_runs_total",
  help: "Total number of contract_events partition-ensure attempts",
  labelNames: ["outcome"],
});

// A monthly partition boundary doesn't need finer than daily checking; the
// underlying CREATE TABLE/INDEX IF NOT EXISTS calls are cheap no-ops on
// every run except the handful of days each month where a new partition
// actually needs creating.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// How many months ahead of "now" to keep pre-created.
const MONTHS_AHEAD = 2;

async function ensureUpcomingPartitions(): Promise<void> {
  const now = new Date();
  try {
    for (let offset = 0; offset <= MONTHS_AHEAD; offset++) {
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      const range = monthRange(target.getUTCFullYear(), target.getUTCMonth() + 1);
      await createContractEventsPartition(pool, range);
    }
    partitionEnsureRunsCounter.inc({ outcome: "success" });
  } catch (err) {
    partitionEnsureRunsCounter.inc({ outcome: "failure" });
    logger.error({ err }, "failed to ensure upcoming contract_events partitions");
  }
}

export function startContractEventsPartitionScheduler(): void {
  setInterval(() => {
    ensureUpcomingPartitions().catch((err) =>
      logger.error({ err }, "contract_events partition-ensure tick error"),
    );
  }, CHECK_INTERVAL_MS);

  // Prime immediately at boot rather than waiting a full day for the first check.
  ensureUpcomingPartitions().catch((err) =>
    logger.error({ err }, "initial contract_events partition-ensure failed"),
  );

  logger.info(
    { intervalMs: CHECK_INTERVAL_MS, monthsAhead: MONTHS_AHEAD },
    "contract_events partition scheduler started",
  );
}
