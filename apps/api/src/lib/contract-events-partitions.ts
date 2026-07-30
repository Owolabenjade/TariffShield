// #228 — shared helpers for contract_events monthly range partitions.
//
// Used by:
//   - migrations/0002_partition_contract_events.ts (one-time cutover)
//   - jobs/ensure-contract-events-partitions.ts (keeps future months pre-created)
//
// Kept as pure, dependency-free functions (no pg import) so both call
// sites can pass in whatever client/pool they already have.

export interface MonthRange {
  /** e.g. "contract_events_2026_07" */
  partitionName: string;
  /** ISO-8601 UTC instant, inclusive lower bound, e.g. "2026-07-01T00:00:00Z" */
  fromDate: string;
  /** ISO-8601 UTC instant, exclusive upper bound (first day of next month) */
  toDate: string;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Builds the partition name and [from, to) bounds for one calendar month.
 * Bounds are emitted with an explicit "Z" (UTC) suffix so the partition
 * boundary doesn't depend on the DDL session's timezone setting — created_at
 * is TIMESTAMPTZ, stored as a UTC instant internally, so the bounds must be
 * anchored the same way or a session with a non-UTC timezone could compute
 * a different (wrong) partition boundary.
 */
export function monthRange(year: number, month1to12: number): MonthRange {
  const mm = String(month1to12).padStart(2, "0");
  const nextYear = month1to12 === 12 ? year + 1 : year;
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const nextMm = String(nextMonth).padStart(2, "0");
  return {
    partitionName: `contract_events_${year}_${mm}`,
    fromDate: `${year}-${mm}-01T00:00:00Z`,
    toDate: `${nextYear}-${nextMm}-01T00:00:00Z`,
  };
}

/**
 * Every calendar month from `start` to `end`, inclusive on both ends.
 * O(m) where m is the number of months spanned — bounded in practice by
 * however much history contract_events already has plus a small lookahead.
 */
export function monthsBetweenInclusive(start: Date, end: Date): MonthRange[] {
  const ranges: MonthRange[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1; // 1-indexed for monthRange()
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    ranges.push(monthRange(year, month));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return ranges;
}

/**
 * Creates one monthly partition of contract_events (no-op if it already
 * exists) plus a LOCAL unique index on (ledger_sequence, event_index).
 *
 * That index is deliberately NOT declared on the contract_events parent.
 * PostgreSQL requires any unique index declared on a partitioned table
 * itself to include every partition-key column (created_at here) — but
 * adding created_at to this index would break the idempotency it exists
 * for: queue.ts / importers.ts rely on it to silently ignore a re-inserted
 * copy of the same on-chain event (ON CONFLICT DO NOTHING), and a retried
 * insert computes a fresh `now()` for created_at, so a created_at-inclusive
 * index would never actually catch the duplicate.
 *
 * The fix is a local (non-inherited) unique index created directly on each
 * partition. A bare `ON CONFLICT DO NOTHING` (no explicit column list) is
 * supported against partitioned tables since PostgreSQL 11 and enforces
 * against whichever constraint the target partition actually violates, so
 * idempotency keeps working correctly. (An explicit
 * `ON CONFLICT (ledger_sequence, event_index) DO NOTHING` would instead
 * fail at parse time, because Postgres only accepts an explicit
 * conflict_target when a matching index exists on the partitioned table
 * itself, not merely on one of its partitions — this is why the three
 * call sites were changed to the bare form alongside this migration.)
 *
 * Because this index is local, it must be (and is) created here for every
 * partition — both the ones the migration creates up front and every one
 * the scheduler job creates going forward.
 */
export async function createContractEventsPartition(
  client: Queryable,
  range: MonthRange,
): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${range.partitionName}
       PARTITION OF contract_events
       FOR VALUES FROM ('${range.fromDate}') TO ('${range.toDate}');`,
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${range.partitionName}_ledger_event_uniq
       ON ${range.partitionName} (ledger_sequence, event_index)
       WHERE ledger_sequence IS NOT NULL AND event_index IS NOT NULL;`,
  );
}
