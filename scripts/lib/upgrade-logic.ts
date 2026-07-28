import { Keypair } from "@stellar/stellar-sdk";

/** The narrow surface of contractClient the upgrade CLI depends on — lets
 * tests inject a mock without needing live network access (#770). */
export interface UpgradeContractClient {
  proposeUpgrade(
    signer: Keypair,
    proposerAddress: string,
    hash: Buffer,
  ): Promise<{ result: unknown; txHash: string }>;
  approveUpgrade(
    signer: Keypair,
    approverAddress: string,
    proposalId: bigint,
  ): Promise<{ txHash: string }>;
}

export class InvalidUpgradeHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpgradeHashError";
  }
}

export class InvalidAdminNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAdminNumberError";
  }
}

/** Parses and validates the --hash option. Soroban contract wasm hashes are
 * always 32 bytes (a SHA-256 digest); anything else is rejected up front
 * rather than sent to the contract. */
export function parseUpgradeHash(hex: string): Buffer {
  const hashBuffer = Buffer.from(hex, "hex");
  if (hashBuffer.length !== 32) {
    throw new InvalidUpgradeHashError(
      `Hash must be 32 bytes, got ${hashBuffer.length} (input: ${JSON.stringify(hex)})`,
    );
  }
  return hashBuffer;
}

/** Resolves which admin keypair signs an approve call. Admin 1 always uses
 * the platform keypair; admins 2 and 3 require their respective secret to be
 * configured — this is deliberately checked here (not left to
 * Keypair.fromSecret's own error) so the failure message names the specific
 * missing env var. */
export function resolveApprovalKeypair(
  adminNumber: string,
  deps: { platformKeypair: Keypair; admin2Secret?: string; admin3Secret?: string },
): Keypair {
  switch (adminNumber) {
    case "1":
      return deps.platformKeypair;
    case "2":
      if (!deps.admin2Secret) throw new Error("ADMIN_2_SECRET not set");
      return Keypair.fromSecret(deps.admin2Secret);
    case "3":
      if (!deps.admin3Secret) throw new Error("ADMIN_3_SECRET not set");
      return Keypair.fromSecret(deps.admin3Secret);
    default:
      throw new InvalidAdminNumberError(
        `Invalid admin number: ${JSON.stringify(adminNumber)}. Must be 1, 2, or 3`,
      );
  }
}

export async function runPropose(
  client: UpgradeContractClient,
  signer: Keypair,
  hashHex: string,
  log: (msg: string) => void = console.log,
): Promise<{ result: unknown; txHash: string }> {
  const hashBuffer = parseUpgradeHash(hashHex);
  log(`Submitting proposal from Admin 1...`);
  const result = await client.proposeUpgrade(signer, signer.publicKey(), hashBuffer);
  log(`✅ Proposal created! Proposal ID: ${result.result}`);
  log(`Tx Hash: ${result.txHash}`);
  return result;
}

export async function runApprove(
  client: UpgradeContractClient,
  adminNumber: string,
  proposalIdRaw: string,
  deps: { platformKeypair: Keypair; admin2Secret?: string; admin3Secret?: string },
  log: (msg: string) => void = console.log,
): Promise<{ txHash: string }> {
  const proposalId = BigInt(proposalIdRaw);
  const kp = resolveApprovalKeypair(adminNumber, deps);

  log(`Approving proposal ${proposalId} from Admin ${adminNumber}...`);
  const result = await client.approveUpgrade(kp, kp.publicKey(), proposalId);
  log(`✅ Approved proposal ${proposalId}`);
  log(`Tx Hash: ${result.txHash}`);
  return result;
}
