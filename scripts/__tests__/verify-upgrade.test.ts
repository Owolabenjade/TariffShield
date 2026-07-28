/**
 * Unit tests for scripts/verify-upgrade.ts.
 *
 * Covers the field-diffing logic (diffAccountFields) that compares on-chain
 * post-upgrade account state against a pre-upgrade backup, and the
 * overallStatus PASS/FAIL determination (determineOverallStatus) based on
 * the failedAccounts count. These were extracted out of the previously
 * inline verification loop in main() specifically so they could be unit
 * tested here without a live database or network connection.
 *
 * The --skip-canary flag path and the full end-to-end run (database query +
 * report generation) are exercised only via manual/staging runs of the
 * script itself — they depend on a live pool.query and TariffShieldClient,
 * which main() wires up directly rather than accepting as injectable
 * dependencies. diffAccountFields and determineOverallStatus are the pure,
 * side-effect-free pieces the issue calls out, and are what's covered below.
 *
 * Run via:  npm run test:scripts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// scripts/verify-upgrade.ts transitively imports apps/api/src/db.ts, which
// validates process.env against a Zod schema at module load time, opens a
// `pg` Pool (lazily — no connection is made until a query runs), and starts
// an unconditional setInterval for pool-exhaustion alerting. Stub the
// required env vars (same values the CI api-integration.yml job uses) before
// dynamically importing the module under test, so the import itself doesn't
// throw — no real database or network connection is ever made from these
// tests, since only the pure diffAccountFields/determineOverallStatus
// exports are exercised below. The import happens inside before() (rather
// than at module top level) so this file doesn't require top-level-await/ESM
// support from the runner.
//
// db.ts's setInterval is never cleared, so this suite must be run with
// `--test-force-exit` (see the test:scripts script in package.json) —
// otherwise the process hangs after all tests finish waiting for a timer
// that will never fire.
let diffAccountFields: (typeof import('../verify-upgrade.js'))['diffAccountFields'];
let determineOverallStatus: (typeof import('../verify-upgrade.js'))['determineOverallStatus'];

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/tariffshield_test';
  process.env.JWT_SECRET ??= 'ci-stub-jwt-secret-not-used-by-migrations-0000';
  process.env.STELLAR_RPC_URL ??= 'https://soroban-testnet.stellar.org';
  process.env.STELLAR_HORIZON_URL ??= 'https://horizon-testnet.stellar.org';
  process.env.STELLAR_NETWORK_PASSPHRASE ??= 'Test SDF Network ; September 2015';
  process.env.TARIFF_SHIELD_CONTRACT_ID ??=
    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  process.env.PLATFORM_STELLAR_SECRET ??=
    'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
  process.env.SURETY_STELLAR_SECRET ??= 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC';

  const mod = await import('../verify-upgrade.js');
  diffAccountFields = mod.diffAccountFields;
  determineOverallStatus = mod.determineOverallStatus;
});

function makeOnChainAccount(
  overrides: Partial<{
    bondId: string;
    collateralBalance: string;
    requiredCollateral: string;
    reserveBalance: string;
    yieldAccrued: string;
    isClawbacked: boolean;
  }> = {}
) {
  const values = {
    bondId: '1001',
    collateralBalance: '5000000',
    requiredCollateral: '4000000',
    reserveBalance: '1000000',
    yieldAccrued: '12345',
    isClawbacked: false,
    ...overrides,
  };
  return {
    bondId: { toString: () => values.bondId },
    collateralBalance: { toString: () => values.collateralBalance },
    requiredCollateral: { toString: () => values.requiredCollateral },
    reserveBalance: { toString: () => values.reserveBalance },
    yieldAccrued: { toString: () => values.yieldAccrued },
    isClawbacked: values.isClawbacked,
  };
}

function makeBackupAccount(
  overrides: Partial<{
    stellarAddress: string;
    bondId: string;
    collateralBalance: string;
    requiredCollateral: string;
    reserveBalance: string;
    yieldAccrued: string;
    isClawbacked: boolean;
  }> = {}
) {
  return {
    stellarAddress: 'GBACKUP',
    bondId: '1001',
    collateralBalance: '5000000',
    requiredCollateral: '4000000',
    reserveBalance: '1000000',
    yieldAccrued: '12345',
    isClawbacked: false,
    ...overrides,
  };
}

describe('diffAccountFields', () => {
  it('returns an empty array when no backup account is provided', () => {
    const account = makeOnChainAccount();
    assert.deepEqual(diffAccountFields(account, undefined), []);
  });

  it('returns an empty array when every field matches the backup', () => {
    const account = makeOnChainAccount();
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), []);
  });

  it('flags bondId when it differs from the backup', () => {
    const account = makeOnChainAccount({ bondId: '1002' });
    const backup = makeBackupAccount({ bondId: '1001' });
    assert.deepEqual(diffAccountFields(account, backup), ['bondId']);
  });

  it('flags collateralBalance when it differs from the backup', () => {
    const account = makeOnChainAccount({ collateralBalance: '9999999' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['collateralBalance']);
  });

  it('flags requiredCollateral when it differs from the backup', () => {
    const account = makeOnChainAccount({ requiredCollateral: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['requiredCollateral']);
  });

  it('flags reserveBalance when it differs from the backup', () => {
    const account = makeOnChainAccount({ reserveBalance: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['reserveBalance']);
  });

  it('flags yieldAccrued when it differs from the backup', () => {
    const account = makeOnChainAccount({ yieldAccrued: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['yieldAccrued']);
  });

  it('flags isClawbacked when it differs from the backup', () => {
    const account = makeOnChainAccount({ isClawbacked: true });
    const backup = makeBackupAccount({ isClawbacked: false });
    assert.deepEqual(diffAccountFields(account, backup), ['isClawbacked']);
  });

  it('flags every changed field at once, in a stable order', () => {
    const account = makeOnChainAccount({
      bondId: '9999',
      collateralBalance: '0',
      isClawbacked: true,
    });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), [
      'bondId',
      'collateralBalance',
      'isClawbacked',
    ]);
  });
});

describe('determineOverallStatus', () => {
  it('returns PASS when there are zero failed accounts', () => {
    assert.equal(determineOverallStatus(0), 'PASS');
  });

  it('returns FAIL when there is at least one failed account', () => {
    assert.equal(determineOverallStatus(1), 'FAIL');
  });

  it('returns FAIL for a large failedAccounts count', () => {
    assert.equal(determineOverallStatus(42), 'FAIL');
  });
});
