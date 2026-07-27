import { Pool, type QueryResult, type QueryResultRow } from "pg";
import pino from "pino";
import client from "prom-client";
import { env } from "./config/env.js";

const logger = pino({ name: "db" });

const url = new URL(env.DATABASE_URL);
const sslRequired = url.searchParams.get("sslmode") === "require";

const basePool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONN_TIMEOUT_MS,
});

// ── Pool monitoring (#264) ────────────────────────────────────────────────────

export const pgPoolEventsTotal = new client.Counter({
  name: "pg_pool_events_total",
  help: "Total count of PostgreSQL pool lifecycle events",
  labelNames: ["event"],
});

// Gauges read the pool's own counters on scrape rather than being tracked by
// hand — `pool.totalCount`/`idleCount`/`waitingCount` are always the source
// of truth, so there's no risk of manual increment/decrement drift.
new client.Gauge({
  name: "pg_pool_active",
  help: "Number of PostgreSQL pool clients currently checked out (in use)",
  collect() {
    this.set(basePool.totalCount - basePool.idleCount);
  },
});

new client.Gauge({
  name: "pg_pool_idle",
  help: "Number of idle PostgreSQL pool clients available for reuse",
  collect() {
    this.set(basePool.idleCount);
  },
});

new client.Gauge({
  name: "pg_pool_waiting",
  help: "Number of queued requests waiting for a PostgreSQL pool client",
  collect() {
    this.set(basePool.waitingCount);
  },
});

basePool.on("connect", () => pgPoolEventsTotal.inc({ event: "connect" }));
basePool.on("acquire", () => pgPoolEventsTotal.inc({ event: "acquire" }));
basePool.on("remove", () => pgPoolEventsTotal.inc({ event: "remove" }));
basePool.on("error", (err) => {
  pgPoolEventsTotal.inc({ event: "error" });
  logger.error({ err }, "PostgreSQL pool error (idle client)");
});

// Alert when the pool is under sustained exhaustion pressure: waitingCount > 5
// for more than 10 consecutive seconds. Checked every second; resets the
// streak the moment waitingCount drops back to <= 5, and only logs once per
// breach (not on every tick past 10s) to avoid alert spam.
const WAITING_ALERT_THRESHOLD = 5;
const WAITING_ALERT_DURATION_MS = 10_000;
const POOL_CHECK_INTERVAL_MS = 1_000;
let waitingBreachSince: number | null = null;
let waitingAlertFired = false;

const poolInterval = setInterval(() => {
  const waiting = basePool.waitingCount;
  if (waiting > WAITING_ALERT_THRESHOLD) {
    if (waitingBreachSince === null) {
      waitingBreachSince = Date.now();
    } else if (!waitingAlertFired && Date.now() - waitingBreachSince >= WAITING_ALERT_DURATION_MS) {
      waitingAlertFired = true;
      logger.error(
        { waiting, thresholdSeconds: WAITING_ALERT_DURATION_MS / 1000 },
        `PostgreSQL pool exhaustion: ${waiting} requests waiting for >${WAITING_ALERT_DURATION_MS / 1000}s`,
      );
    }
  } else {
    waitingBreachSince = null;
    waitingAlertFired = false;
  }
}, POOL_CHECK_INTERVAL_MS);
if (typeof poolInterval.unref === "function") {
  poolInterval.unref();
}

// ── Prometheus metrics (#373) ─────────────────────────────────────────────────

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of PostgreSQL queries in seconds",
  labelNames: ["query_name"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const dbSlowQueriesTotal = new client.Counter({
  name: "db_slow_queries_total",
  help: "Total number of slow PostgreSQL queries",
  labelNames: ["threshold"],
});

// ── Query timing wrapper ──────────────────────────────────────────────────────

const SLOW_WARN_MS = 500;
const SLOW_ERROR_MS = 2000;
const SQL_TRUNCATE_LEN = 500;

function sanitizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, "?")
    .replace(/'[^']*'/g, "'?'")
    .slice(0, SQL_TRUNCATE_LEN);
}

function inferQueryName(sql: string): string {
  const s = sql.trim().toUpperCase();
  const m = s.match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+(?:INTO\s+|FROM\s+|TABLE\s+)?(\w+)?/);
  return m ? `${m[1]!.toLowerCase()}${m[2] ? `_${m[2]!.toLowerCase()}` : ""}` : "unknown";
}

async function timedQuery<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[],
  queryName?: string,
): Promise<QueryResult<R>> {
  const start = Date.now();
  const name = queryName ?? inferQueryName(sql);
  const endTimer = dbQueryDurationSeconds.startTimer({ query_name: name });

  try {
    const result = await basePool.query<R>(sql, values);
    const durationMs = Date.now() - start;
    endTimer();

    if (durationMs >= SLOW_ERROR_MS) {
      dbSlowQueriesTotal.inc({ threshold: "2000ms" });
      logger.error(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        "critically slow query",
      );
    } else if (durationMs >= SLOW_WARN_MS) {
      dbSlowQueriesTotal.inc({ threshold: "500ms" });
      logger.warn(
        { query: sanitizeSql(sql), durationMs, rowCount: result.rowCount, caller: name },
        "slow query",
      );
    }

    return result;
  } catch (err) {
    endTimer();
    throw err;
  }
}

export const pool = {
  query: timedQuery,
  connect: () => basePool.connect(),
  end: () => basePool.end(),
};

// ── Schema migrations ─────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  const { runMigrations } = await import("./migrations/runner.js");
  await runMigrations("up");
}

export async function rollback(): Promise<void> {
  const { runMigrations } = await import("./migrations/runner.js");
  await runMigrations("rollback");
}

// ── importer_metrics_mv (#251) ────────────────────────────────────────────────

export interface ImporterMetrics {
  totalImporters: number;
  totalBondValue: string;
  avgBalance: string;
  complianceRate: number;
  topupCount30d: number;
  refreshedAt: string;
}

/**
 * Read the pre-computed dashboard statistics from importer_metrics_mv.
 * Backed by a unique index on the (single-row) view, so this is a fast
 * indexed lookup rather than a live aggregate — target < 5ms p95.
 */
export async function getImporterMetrics(): Promise<ImporterMetrics> {
  const result = await timedQuery<{
    total_importers: number;
    total_bond_value: string;
    avg_balance: string;
    compliance_rate: string;
    topup_count_30d: number;
    refreshed_at: Date;
  }>("SELECT * FROM importer_metrics_mv WHERE singleton_id = 1", undefined, "select_importer_metrics_mv");

  const row = result.rows[0];
  if (!row) {
    return {
      totalImporters: 0,
      totalBondValue: "0",
      avgBalance: "0",
      complianceRate: 100,
      topupCount30d: 0,
      refreshedAt: new Date(0).toISOString(),
    };
  }

  return {
    totalImporters: row.total_importers,
    totalBondValue: row.total_bond_value,
    avgBalance: row.avg_balance,
    complianceRate: Number(row.compliance_rate),
    topupCount30d: row.topup_count_30d,
    refreshedAt: row.refreshed_at.toISOString(),
  };
}

/**
 * Refresh importer_metrics_mv without blocking concurrent reads.
 * Requires the unique index created alongside the view (see migrate()).
 */
export async function refreshImporterMetrics(): Promise<void> {
  await timedQuery(
    "REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics_mv",
    undefined,
    "refresh_importer_metrics_mv",
  );
}

/**
 * Refresh the importer_metrics materialized view concurrently without blocking reads.
 * 
 * Refresh Cadence:
 * - Triggered on-demand inside the tariff upload POST handler (`/importers/:id/upload-tariff-csv`).
 * - Can also be run on a background timer or cron (e.g. every 5 minutes) to sync async
 *   on-chain ledger events (deposits, withdrawals, clawbacks).
 * 
 * Staleness Window:
 * - Near-zero latency for tariff upload mutations since refresh is triggered immediately.
 * - Up to 5 minutes latency (or since last indexer run) for on-chain events if relying on periodic refresh.
 */
export async function refreshImporterMetricsView(): Promise<void> {
  await timedQuery(
    "REFRESH MATERIALIZED VIEW CONCURRENTLY importer_metrics",
    undefined,
    "refresh_importer_metrics",
  );
}


export async function getLastProcessedLedger(): Promise<number | null> {
  const result = await timedQuery<{ last_processed_ledger: number }>(
    "SELECT last_processed_ledger FROM indexer_state WHERE id = $1",
    ["default"],
    "select_indexer_state",
  );
  if (!result.rowCount || result.rowCount === 0) {
    return null;
  }
  return result.rows[0]!.last_processed_ledger;
}

export async function updateLastProcessedLedger(ledger: number): Promise<void> {
  await timedQuery(
    `INSERT INTO indexer_state (id, last_processed_ledger, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE
     SET last_processed_ledger = EXCLUDED.last_processed_ledger,
         updated_at = now()`,
    ["default", ledger],
    "upsert_indexer_state",
  );
}

/**
 * Pings the database to check if it's alive.
 */
export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Returns all bonds that have been registered on-chain.
 */
export async function getActiveBonds(): Promise<{ bondId: string; stellarAddress: string; dbBalance: string }[]> {
  const result = await pool.query<{ bond_id: string; stellar_address: string; collateral_balance: string }>(
    "SELECT bond_id, stellar_address, collateral_balance FROM importers WHERE registered_on_chain_tx IS NOT NULL"
  );
  return result.rows.map((row) => ({
    bondId: row.bond_id,
    stellarAddress: row.stellar_address,
    dbBalance: row.collateral_balance,
  }));
}

export async function recordAuthenticationAttempt(
  email: string,
  success: boolean,
  userId?: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  await timedQuery(
    `INSERT INTO authentication_attempts (email, success, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, success, userId ?? null, ipAddress ?? null, userAgent ?? null],
    "insert_auth_attempt",
  );
}

export async function getFailedAuthAttempts(email: string, withinMinutes: number = 30): Promise<number> {
  const result = await timedQuery<{ count: string }>(
    `SELECT COUNT(*) as count FROM authentication_attempts
     WHERE email = $1 AND success = FALSE
     AND attempted_at > now() - INTERVAL '${withinMinutes} minutes'`,
    [email],
    "count_failed_auth_attempts",
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function lockAccountTemporarily(userId: string, durationMinutes: number = 30): Promise<void> {
  await timedQuery(
    `UPDATE users SET locked_until = now() + INTERVAL '${durationMinutes} minutes'
     WHERE id = $1`,
    [userId],
    "lock_account",
  );
}

export async function recordSecurityIncident(
  severity: "P0" | "P1" | "P2" | "P3",
  description: string,
  affectedScope?: string,
): Promise<string> {
  const incidentId = `INC-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO security_incidents (incident_id, severity, description, affected_scope)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [incidentId, severity, description, affectedScope ?? null],
    "insert_security_incident",
  );
  return result.rows[0]?.id ?? "";
}

export async function createDataErasureRequest(
  userId: string,
  importerId?: string,
): Promise<string> {
  const requestId = `ERASE-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const slaDealine = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO data_erasure_requests (request_id, user_id, importer_id, sla_deadline, affected_fields)
     VALUES ($1, $2, $3, $4, ARRAY['legal_name', 'ein', 'email'])
     RETURNING id`,
    [requestId, userId, importerId ?? null, slaDealine],
    "insert_erasure_request",
  );
  return result.rows[0]?.id ?? "";
}

// ── SOC 2 CC6 — Session management (#306) ────────────────────────────────────

const SESSION_INACTIVITY_MINUTES = 15;

export async function createSession(
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<string> {
  const result = await timedQuery<{ id: string }>(
    `INSERT INTO user_sessions (user_id, ip_address, user_agent)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, ipAddress ?? null, userAgent ?? null],
    "insert_user_session",
  );
  return result.rows[0]!.id;
}

export async function validateSession(sessionId: string): Promise<boolean> {
  const result = await timedQuery<{ id: string }>(
    `SELECT id FROM user_sessions
     WHERE id = $1
       AND revoked_at IS NULL
       AND last_activity > now() - INTERVAL '${SESSION_INACTIVITY_MINUTES} minutes'`,
    [sessionId],
    "validate_user_session",
  );
  return (result.rowCount ?? 0) > 0;
}

export function touchSession(sessionId: string): void {
  timedQuery(
    "UPDATE user_sessions SET last_activity = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
    "touch_user_session",
  ).catch(() => {});
}

export async function revokeSession(sessionId: string): Promise<void> {
  await timedQuery(
    "UPDATE user_sessions SET revoked_at = now() WHERE id = $1",
    [sessionId],
    "revoke_user_session",
  );
}

export async function getActiveSessionCount(userId: string): Promise<number> {
  const result = await timedQuery<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
       AND last_activity > now() - INTERVAL '${SESSION_INACTIVITY_MINUTES} minutes'`,
    [userId],
    "count_active_sessions",
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function revokeOldestSession(userId: string): Promise<void> {
  await timedQuery(
    `UPDATE user_sessions SET revoked_at = now()
     WHERE id = (
       SELECT id FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY last_activity ASC
       LIMIT 1
     )`,
    [userId],
    "revoke_oldest_session",
  );
}

export async function getStaleAccounts(
  days: number,
): Promise<Array<{ id: string; email: string; last_login: string | null }>> {
  const result = await timedQuery<{ id: string; email: string; last_login: string | null }>(
    `SELECT u.id, u.email,
            MAX(a.attempted_at) AS last_login
       FROM users u
       LEFT JOIN authentication_attempts a
         ON a.user_id = u.id AND a.success = TRUE
      GROUP BY u.id, u.email
     HAVING MAX(a.attempted_at) IS NULL
         OR MAX(a.attempted_at) < now() - ($1::integer * INTERVAL '1 day')
      ORDER BY last_login ASC NULLS FIRST`,
    [days],
    "select_stale_accounts",
  );
  return result.rows;
}
