import { PoolClient } from "pg";
import { monthsBetweenInclusive, createContractEventsPartition } from "../lib/contract-events-partitions.js";

// #228 — range-partition contract_events by month.
//
// WHY: contract_events gets one row per indexed on-chain event (deposits,
// withdrawals, top-ups, yield accrual, clawbacks, oracle updates). At scale
// it becomes the largest table in the schema. Monthly range partitioning on
// created_at gives:
//   - partition pruning for time-bounded queries,
//   - independent VACUUM/ANALYZE per month instead of one huge relation,
//   - the ability to drop an old month with DROP TABLE (near-instant, no
//     row-by-row DELETE and no table-wide lock) once retention allows it.
//
// PRIMARY KEY: PostgreSQL requires every unique/PK constraint on a
// partitioned table to include all partition-key columns, so the PK
// becomes (id, created_at) instead of just (id). `id` keeps its own
// DEFAULT and is unique in practice (uuid_generate_v4 collisions are not a
// realistic concern); nothing in the codebase looks up contract_events by
// `id` alone — verified: every SELECT is scoped by importer_id/kind/
// created_at, and inserts key off (ledger_sequence, event_index) — so
// dropping the standalone PK-on-id guarantee is safe here.
//
// IDEMPOTENCY: see the createContractEventsPartition() doc comment in
// lib/contract-events-partitions.ts for why the (ledger_sequence,
// event_index) unique index has to be local-per-partition rather than
// declared on the parent, and why queue.ts / importers.ts were changed
// from `ON CONFLICT (ledger_sequence, event_index) DO NOTHING` to a bare
// `ON CONFLICT DO NOTHING` alongside this migration.
//
// COMPATIBILITY: every existing query against contract_events in
// importers.ts (importer_id-scoped SELECTs, id-cursor pagination) remains
// correct against a partitioned table with no query changes — Postgres
// transparently fans a query lacking a created_at predicate out across
// every partition (Append/Merge Append), using each partition's own
// importer_id/id indexes. Partition pruning specifically benefits the
// created_at-range-scoped queries.

// How far past "now" to pre-create partitions, so ingestion doesn't stall
// on day one waiting for the scheduler job (see
// jobs/ensure-contract-events-partitions.ts) to catch up.
const FUTURE_MONTH_LOOKAHEAD_MONTHS = 3;

export async function up(client: PoolClient): Promise<void> {
  // 1. Preserve the existing table (and its data) under a temporary name so
  //    the new partitioned table can take over the `contract_events` name.
  await client.query(`ALTER TABLE contract_events RENAME TO contract_events_pre_partition;`);

  // The old indexes travel with the renamed table but occupy names this
  // migration wants to reuse on the new partitioned table. Dropping an
  // index only removes the index structure, not the underlying rows.
  await client.query(`DROP INDEX IF EXISTS idx_contract_events_importer;`);
  await client.query(`DROP INDEX IF EXISTS idx_contract_events_importer_kind;`);
  await client.query(`DROP INDEX IF EXISTS idx_contract_events_importer_id_pagination;`);
  await client.query(`DROP INDEX IF EXISTS idx_contract_events_created_at_brin;`);
  await client.query(`DROP INDEX IF EXISTS idx_contract_events_ledger_event;`);

  // 2. Create the partitioned parent.
  await client.query(`
    CREATE TABLE contract_events (
      id UUID NOT NULL DEFAULT uuid_generate_v4(),
      importer_id UUID REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount NUMERIC(20, 0),
      tx_hash TEXT NOT NULL,
      raw JSONB,
      ledger_sequence INTEGER,
      event_index INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
  `);

  // 3. Determine which months need partitions: every month spanned by the
  //    existing data, plus a lookahead buffer past the current month.
  const { rows } = await client.query<{ min_created: Date | null; max_created: Date | null }>(
    `SELECT MIN(created_at) AS min_created, MAX(created_at) AS max_created FROM contract_events_pre_partition;`,
  );
  const now = new Date();
  const lookaheadEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + FUTURE_MONTH_LOOKAHEAD_MONTHS, 1),
  );
  const earliest = rows[0]?.min_created ?? now;
  const latest = rows[0]?.max_created ?? now;
  const rangeEnd = latest.getTime() > lookaheadEnd.getTime() ? latest : lookaheadEnd;

  for (const range of monthsBetweenInclusive(earliest, rangeEnd)) {
    await createContractEventsPartition(client, range);
  }

  // Safety net: catch any row whose created_at falls outside the computed
  // range (clock skew, a manually-inserted historical row) so the
  // migration can never lose data to a missing partition.
  await client.query(`CREATE TABLE IF NOT EXISTS contract_events_default PARTITION OF contract_events DEFAULT;`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contract_events_default_ledger_event_uniq
      ON contract_events_default (ledger_sequence, event_index)
      WHERE ledger_sequence IS NOT NULL AND event_index IS NOT NULL;
  `);

  // 4. Indexes declared on the parent auto-propagate to every current and
  //    future partition — this is the "global partitioned index" option
  //    from the issue's acceptance criteria, used for the two importer-
  //    scoped indexes plus the pagination and BRIN indexes.
  await client.query(`CREATE INDEX idx_contract_events_importer ON contract_events(importer_id, created_at DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_importer_kind ON contract_events(importer_id, kind, created_at DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_importer_id_pagination ON contract_events(importer_id, id DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_created_at_brin ON contract_events USING BRIN (created_at) WITH (pages_per_range = 32);`);

  // 5. Copy every existing row across in a single INSERT ... SELECT (one
  //    sequential scan + append, no per-row round trips).
  await client.query(`
    INSERT INTO contract_events
      (id, importer_id, kind, amount, tx_hash, raw, ledger_sequence, event_index, created_at)
    SELECT id, importer_id, kind, amount, tx_hash, raw, ledger_sequence, event_index, created_at
    FROM contract_events_pre_partition;
  `);

  // 6. Verify no rows were lost before dropping the source table. Any
  //    mismatch throws, which rolls back the whole migration transaction.
  const before = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM contract_events_pre_partition;`,
  );
  const after = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM contract_events;`,
  );
  if (before.rows[0]!.count !== after.rows[0]!.count) {
    throw new Error(
      `contract_events partition migration row-count mismatch: ` +
        `${before.rows[0]!.count} rows before, ${after.rows[0]!.count} rows after. Aborting.`,
    );
  }

  await client.query(`DROP TABLE contract_events_pre_partition;`);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE contract_events RENAME TO contract_events_partitioned;`);

  await client.query(`
    CREATE TABLE contract_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount NUMERIC(20, 0),
      tx_hash TEXT NOT NULL,
      raw JSONB,
      ledger_sequence INTEGER,
      event_index INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    INSERT INTO contract_events
      (id, importer_id, kind, amount, tx_hash, raw, ledger_sequence, event_index, created_at)
    SELECT id, importer_id, kind, amount, tx_hash, raw, ledger_sequence, event_index, created_at
    FROM contract_events_partitioned;
  `);

  await client.query(`CREATE INDEX idx_contract_events_importer ON contract_events(importer_id, created_at DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_importer_kind ON contract_events(importer_id, kind, created_at DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_importer_id_pagination ON contract_events(importer_id, id DESC);`);
  await client.query(`CREATE INDEX idx_contract_events_created_at_brin ON contract_events USING BRIN (created_at) WITH (pages_per_range = 32);`);
  await client.query(`
    CREATE UNIQUE INDEX idx_contract_events_ledger_event
      ON contract_events(ledger_sequence, event_index)
      WHERE ledger_sequence IS NOT NULL AND event_index IS NOT NULL;
  `);

  // Dropping a partitioned parent automatically drops all its partitions.
  await client.query(`DROP TABLE contract_events_partitioned CASCADE;`);
}
