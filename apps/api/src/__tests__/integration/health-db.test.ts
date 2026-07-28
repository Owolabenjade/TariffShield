/**
 * Tests for the pool configuration and GET /health/db endpoint added by #241.
 *
 * Run via: node --import tsx/esm --test src/__tests__/integration/health-db.test.ts
 *
 * getPoolStats() only reads pg.Pool's own counters (never opens a real
 * connection to read them), so these run without a live PostgreSQL instance.
 * The env stubs mirror apps/api/src/migrate.ts's approach for running
 * non-DB-dependent code paths without a full .env.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub("DATABASE_URL", "postgres://fake:fake@localhost:1/fake");
stub("JWT_SECRET", "test-stub-jwt-secret-not-used-by-this-suite-00000");
stub("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org");
stub("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org");
stub("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
stub("TARIFF_SHIELD_CONTRACT_ID", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
stub("PLATFORM_STELLAR_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB");
stub("SURETY_STELLAR_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC");

const { getPoolStats, pool } = await import("../../db.js");

describe("db pool configuration (#241)", () => {
  it("getPoolStats returns the pool's own counters without opening a connection", () => {
    const stats = getPoolStats();
    assert.equal(typeof stats.totalCount, "number");
    assert.equal(typeof stats.idleCount, "number");
    assert.equal(typeof stats.waitingCount, "number");
    // No connection has been attempted yet, so all counters start at 0.
    assert.equal(stats.totalCount, 0);
    assert.equal(stats.idleCount, 0);
    assert.equal(stats.waitingCount, 0);
  });

  it("pool.query rejects against an unreachable database instead of hanging", async () => {
    await assert.rejects(() => pool.query("SELECT 1"));
  });
});

describe("GET /health/db route (#241)", () => {
  it("reports status failed with pool stats when the database is unreachable", async () => {
    const { healthRouter } = await import("../../routes/health.js");
    const layer = (healthRouter.stack as any[]).find(
      (l) => l.route?.path === "/db" && l.route.methods.get,
    );
    assert.ok(layer, "GET /db route must be registered on healthRouter");

    const handler = layer.route.stack[0].handle;
    let statusCode = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    await handler({} as any, res as any, (() => {}) as any);

    assert.equal(statusCode, 503);
    assert.deepEqual(body, {
      status: "failed",
      pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    });
  });
});
