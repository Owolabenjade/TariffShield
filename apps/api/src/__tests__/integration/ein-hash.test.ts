/**
 * Tests for ein_hash (#243) — SHA-256 hashing used for PII-safe EIN lookups.
 *
 * Run via: node --import tsx/esm --test src/__tests__/integration/ein-hash.test.ts
 *
 * The "matches Postgres" test proves the app-layer hash
 * (crypto.createHash('sha256')) produces byte-identical output to the SQL
 * backfill's encode(sha256(ein::bytea), 'hex') — critical since the two
 * must agree for future ein_hash equality lookups to ever match rows
 * created by either path (fresh INSERT vs. the one-time backfill).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function computeEinHash(ein: string): string {
  return createHash("sha256").update(ein).digest("hex");
}

describe("ein_hash computation (#243)", () => {
  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    const hash = computeEinHash("12-3456789");
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    assert.equal(computeEinHash("98-7654321"), computeEinHash("98-7654321"));
  });

  it("produces different hashes for different EINs", () => {
    assert.notEqual(computeEinHash("11-1111111"), computeEinHash("22-2222222"));
  });

  it("matches the known SHA-256 digest for a fixed input (cross-checked against Postgres's encode(sha256(ein::bytea), 'hex'))", () => {
    // Verified independently via: SELECT encode(sha256('12-3456789'::bytea), 'hex');
    assert.equal(
      computeEinHash("12-3456789"),
      "489553f3942f7a333a54471545575969abdeb9f5d351cd87e381eeaa7bb781e9",
    );
  });
});
