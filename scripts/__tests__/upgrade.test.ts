/**
 * Unit tests for scripts/lib/upgrade-logic.ts — the multi-sig propose/approve
 * logic behind scripts/upgrade.ts's CLI (#770).
 *
 * Run with:  npx tsx --test scripts/__tests__/upgrade.test.ts
 * (or, repo-wide: npm run test:scripts)
 *
 * Covers hash-length validation for propose, the admin-selection branch
 * logic in approve (including the ADMIN_2_SECRET/ADMIN_3_SECRET-not-set
 * error paths), and that a network failure from the (mocked)
 * contractClient surfaces as a rejected promise. contractClient.proposeUpgrade/
 * approveUpgrade are mocked throughout via the UpgradeContractClient
 * interface so no live network access is required.
 *
 * The pure CLI logic (hash validation, admin-selection, calling the client)
 * lives in scripts/lib/upgrade-logic.ts specifically so it can be imported
 * here without pulling in apps/api/src/stellar.js's full dependency chain
 * (a strict, production-shaped env schema validated at module load time,
 * plus the @tariffshield/sdk workspace package) — scripts/upgrade.ts itself
 * is the thin Commander CLI wrapper around these functions and is not
 * re-tested here beyond that split.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  InvalidAdminNumberError,
  InvalidUpgradeHashError,
  parseUpgradeHash,
  resolveApprovalKeypair,
  runApprove,
  runPropose,
  type UpgradeContractClient,
} from "../lib/upgrade-logic.js";

const VALID_HASH_HEX = "a".repeat(64); // 32 bytes
const platformKeypair = Keypair.random();
const admin2Keypair = Keypair.random();
const admin3Keypair = Keypair.random();

function noopLog(): void {}

describe("parseUpgradeHash", () => {
  it("accepts a valid 32-byte hex hash", () => {
    const hashBuffer = parseUpgradeHash(VALID_HASH_HEX);
    assert.equal(hashBuffer.length, 32);
  });

  it("rejects a hash shorter than 32 bytes", () => {
    assert.throws(() => parseUpgradeHash("aa"), InvalidUpgradeHashError);
  });

  it("rejects a hash longer than 32 bytes", () => {
    assert.throws(() => parseUpgradeHash("a".repeat(66)), InvalidUpgradeHashError);
  });

  it("rejects an empty hash", () => {
    assert.throws(() => parseUpgradeHash(""), InvalidUpgradeHashError);
  });

  it("includes the actual byte length in the error message", () => {
    assert.throws(() => parseUpgradeHash("aa"), /Hash must be 32 bytes, got 1/);
  });
});

describe("resolveApprovalKeypair", () => {
  it("selects the platform keypair for admin 1", () => {
    const kp = resolveApprovalKeypair("1", { platformKeypair });
    assert.equal(kp.publicKey(), platformKeypair.publicKey());
  });

  it("selects a keypair derived from ADMIN_2_SECRET for admin 2", () => {
    const kp = resolveApprovalKeypair("2", {
      platformKeypair,
      admin2Secret: admin2Keypair.secret(),
    });
    assert.equal(kp.publicKey(), admin2Keypair.publicKey());
  });

  it("throws when admin 2 is selected but ADMIN_2_SECRET is not set", () => {
    assert.throws(
      () => resolveApprovalKeypair("2", { platformKeypair }),
      /ADMIN_2_SECRET not set/,
    );
  });

  it("selects a keypair derived from ADMIN_3_SECRET for admin 3", () => {
    const kp = resolveApprovalKeypair("3", {
      platformKeypair,
      admin3Secret: admin3Keypair.secret(),
    });
    assert.equal(kp.publicKey(), admin3Keypair.publicKey());
  });

  it("throws when admin 3 is selected but ADMIN_3_SECRET is not set", () => {
    assert.throws(
      () => resolveApprovalKeypair("3", { platformKeypair }),
      /ADMIN_3_SECRET not set/,
    );
  });

  it("throws InvalidAdminNumberError for an admin number outside 1/2/3", () => {
    assert.throws(() => resolveApprovalKeypair("4", { platformKeypair }), InvalidAdminNumberError);
  });

  it("throws InvalidAdminNumberError for a non-numeric admin value", () => {
    assert.throws(
      () => resolveApprovalKeypair("admin-one", { platformKeypair }),
      InvalidAdminNumberError,
    );
  });
});

describe("runPropose", () => {
  it("calls contractClient.proposeUpgrade with the signer, its own address, and the parsed hash", async () => {
    let capturedArgs: unknown[] = [];
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async (...args) => {
        capturedArgs = args;
        return { result: 42, txHash: "tx-abc" };
      },
      approveUpgrade: async () => {
        throw new Error("not used in this test");
      },
    };

    const result = await runPropose(mockClient, platformKeypair, VALID_HASH_HEX, noopLog);

    assert.equal(result.result, 42);
    assert.equal(result.txHash, "tx-abc");
    assert.equal(capturedArgs[0], platformKeypair);
    assert.equal(capturedArgs[1], platformKeypair.publicKey());
    assert.ok(Buffer.isBuffer(capturedArgs[2]));
    assert.equal((capturedArgs[2] as Buffer).length, 32);
  });

  it("rejects with InvalidUpgradeHashError before calling the client, for a bad hash", async () => {
    let called = false;
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        called = true;
        return { result: null, txHash: "unused" };
      },
      approveUpgrade: async () => {
        throw new Error("not used in this test");
      },
    };

    await assert.rejects(
      () => runPropose(mockClient, platformKeypair, "bad-hash", noopLog),
      InvalidUpgradeHashError,
    );
    assert.equal(called, false, "the contract client must not be called for an invalid hash");
  });

  it("propagates a rejection from the contract client (e.g. RPC failure)", async () => {
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("simulated RPC failure");
      },
      approveUpgrade: async () => {
        throw new Error("not used in this test");
      },
    };

    await assert.rejects(
      () => runPropose(mockClient, platformKeypair, VALID_HASH_HEX, noopLog),
      /simulated RPC failure/,
    );
  });
});

describe("runApprove", () => {
  it("calls contractClient.approveUpgrade with admin 1's keypair when --admin 1", async () => {
    let capturedArgs: unknown[] = [];
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async (...args) => {
        capturedArgs = args;
        return { txHash: "tx-approve-1" };
      },
    };

    const result = await runApprove(mockClient, "1", "7", { platformKeypair }, noopLog);

    assert.equal(result.txHash, "tx-approve-1");
    assert.equal(capturedArgs[0], platformKeypair);
    assert.equal(capturedArgs[1], platformKeypair.publicKey());
    assert.equal(capturedArgs[2], 7n);
  });

  it("calls contractClient.approveUpgrade with admin 2's keypair when --admin 2 and ADMIN_2_SECRET is set", async () => {
    let capturedSignerAddress: string | undefined;
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async (_signer, address) => {
        capturedSignerAddress = address;
        return { txHash: "tx-approve-2" };
      },
    };

    await runApprove(
      mockClient,
      "2",
      "7",
      { platformKeypair, admin2Secret: admin2Keypair.secret() },
      noopLog,
    );

    assert.equal(capturedSignerAddress, admin2Keypair.publicKey());
  });

  it("rejects with the ADMIN_2_SECRET-not-set error before calling the client, for --admin 2 with no secret configured", async () => {
    let called = false;
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async () => {
        called = true;
        return { txHash: "unused" };
      },
    };

    await assert.rejects(
      () => runApprove(mockClient, "2", "7", { platformKeypair }, noopLog),
      /ADMIN_2_SECRET not set/,
    );
    assert.equal(called, false, "the contract client must not be called when the admin secret is missing");
  });

  it("rejects with the ADMIN_3_SECRET-not-set error before calling the client, for --admin 3 with no secret configured", async () => {
    let called = false;
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async () => {
        called = true;
        return { txHash: "unused" };
      },
    };

    await assert.rejects(
      () => runApprove(mockClient, "3", "7", { platformKeypair }, noopLog),
      /ADMIN_3_SECRET not set/,
    );
    assert.equal(called, false, "the contract client must not be called when the admin secret is missing");
  });

  it("rejects with InvalidAdminNumberError for an out-of-range --admin value", async () => {
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async () => {
        throw new Error("must not be called");
      },
    };

    await assert.rejects(
      () => runApprove(mockClient, "9", "7", { platformKeypair }, noopLog),
      InvalidAdminNumberError,
    );
  });

  it("propagates a rejection from the contract client (e.g. RPC failure)", async () => {
    const mockClient: UpgradeContractClient = {
      proposeUpgrade: async () => {
        throw new Error("not used in this test");
      },
      approveUpgrade: async () => {
        throw new Error("simulated RPC failure");
      },
    };

    await assert.rejects(
      () => runApprove(mockClient, "1", "7", { platformKeypair }, noopLog),
      /simulated RPC failure/,
    );
  });
});
