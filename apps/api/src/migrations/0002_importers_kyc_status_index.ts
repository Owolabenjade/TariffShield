import { PoolClient } from "pg";

// #229 — index for the kyc_status column added on importers by 0001.
//
// kyc_status (with its NOT NULL DEFAULT 'pending' CHECK constraint) already
// exists as of 0001_initial_schema.ts, so existing rows are already
// backfilled by PostgreSQL's ADD COLUMN ... DEFAULT fast-default mechanism
// — no separate data backfill is needed here. This migration only adds the
// index that admin-dashboard filtering (`GET /admin/importers?kyc_status=`)
// and the kyc_status = 'approved' route guards benefit from.
//
// This has to be its own migration (not folded into 0001) because the
// runner only re-applies migrations with a version higher than the highest
// one already recorded in schema_migrations — editing 0001 after it has
// been applied anywhere would silently skip the new DDL on every database
// that already ran it.

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_importers_kyc_status ON importers(kyc_status);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_importers_kyc_status;`);
}
