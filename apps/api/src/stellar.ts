import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TariffShieldClient } from '@tariffshield/sdk';
import client from 'prom-client';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { env } from './config/env.js';
import { createRpcServer } from './lib/soroban/rpcClient.js';

const tracer = trace.getTracer('tariffshield-stellar');

// #339 — general admin (registration, withdrawals, upgrades)
export const platformKeypair = Keypair.fromSecret(env.PLATFORM_STELLAR_SECRET);
export const suretyKeypair = Keypair.fromSecret(env.SURETY_STELLAR_SECRET);
// #339 — oracle-only role (set_required_collateral); falls back to platformKeypair in dev
export const oracleKeypair = env.ORACLE_STELLAR_SECRET
  ? Keypair.fromSecret(env.ORACLE_STELLAR_SECRET)
  : platformKeypair;

// #332 — emergency oracle override role
export const emergencyOracleKeypair = env.EMERGENCY_ADMIN_SECRET
  ? Keypair.fromSecret(env.EMERGENCY_ADMIN_SECRET)
  : platformKeypair;

export const sorobanRpcCallsTotal = new client.Counter({
  name: 'soroban_rpc_calls_total',
  help: 'Total number of Soroban RPC calls made',
  labelNames: ['method', 'success'],
});

export const sorobanRpcDurationSeconds = new client.Histogram({
  name: 'soroban_rpc_duration_seconds',
  help: 'Duration of Soroban RPC calls in seconds',
  labelNames: ['method'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// #249 — a single persistent Soroban RPC client, created once at module
// load and reused by every call site (contractClient, getCurrentLedgerSequence,
// pingRpc), instead of a new client (and underlying HTTP connection) per
// request. Paired with keep-alive (enabled globally in rpcClient.ts), this
// lets connections actually be reused instead of paying a fresh TCP/TLS
// handshake on every call.
let rpcServer = createRpcServer(env.STELLAR_RPC_URL);

const RECONNECT_MAX_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 250;

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` against the current singleton RPC server. If it fails with a
 * connection-level error (as opposed to e.g. a validation error from the
 * RPC endpoint itself), the singleton is rebuilt and the call retried with
 * exponential backoff, up to RECONNECT_MAX_RETRIES times — this recovers
 * from the RPC endpoint restarting without requiring the whole API process
 * to restart.
 */
async function withRpcReconnect<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RECONNECT_MAX_RETRIES; attempt++) {
    try {
      return await fn(rpcServer);
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err) || attempt === RECONNECT_MAX_RETRIES) {
        throw err;
      }
      rpcServer = createRpcServer(env.STELLAR_RPC_URL);
      await sleep(RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

// Note: TariffShieldClient stores the server instance it's given at
// construction time (it doesn't expose a way to swap it later), so
// contractClient calls don't get the reconnect-with-backoff behavior that
// withRpcReconnect gives getCurrentLedgerSequence/pingRpc below — but they
// do still benefit from the shared singleton + keep-alive, avoiding a new
// connection per call.
const baseClient = new TariffShieldClient({
  rpcUrl: env.STELLAR_RPC_URL,
  contractId: env.TARIFF_SHIELD_CONTRACT_ID,
  networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
  server: rpcServer,
});

export const contractClient = new Proxy(baseClient, {
  get(target, prop, receiver) {
    const original = Reflect.get(target, prop, receiver);
    if (typeof original === 'function') {
      return async (...args: any[]) => {
        const methodName = String(prop);
        return tracer.startActiveSpan(`soroban.rpc.${methodName}`, async (span) => {
          span.setAttributes({
            'soroban.method': methodName,
            'soroban.network': env.STELLAR_NETWORK_PASSPHRASE,
          });
          const start = process.hrtime();
          try {
            const result = await original.apply(target, args);
            const diff = process.hrtime(start);
            const duration = diff[0] + diff[1] / 1e9;
            sorobanRpcCallsTotal.inc({ method: methodName, success: 'true' });
            sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            const diff = process.hrtime(start);
            const duration = diff[0] + diff[1] / 1e9;
            sorobanRpcCallsTotal.inc({ method: methodName, success: 'false' });
            sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    }
    return original;
  },
});

export const explorerTx = (hash: string): string =>
  `https://stellar.expert/explorer/${env.STELLAR_NETWORK}/tx/${hash}`;

export async function getCurrentLedgerSequence(): Promise<number> {
  const methodName = 'getLatestLedger';
  return tracer.startActiveSpan(`soroban.rpc.${methodName}`, async (span) => {
    span.setAttributes({
      'soroban.method': methodName,
      'soroban.network': env.STELLAR_NETWORK_PASSPHRASE,
    });
    const start = process.hrtime();
    try {
      const latest = await withRpcReconnect((server) => server.getLatestLedger());
      const diff = process.hrtime(start);
      const duration = diff[0] + diff[1] / 1e9;
      sorobanRpcCallsTotal.inc({ method: methodName, success: 'true' });
      sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
      span.setStatus({ code: SpanStatusCode.OK });
      return latest.sequence;
    } catch (err) {
      const diff = process.hrtime(start);
      const duration = diff[0] + diff[1] / 1e9;
      sorobanRpcCallsTotal.inc({ method: methodName, success: 'false' });
      sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Pings the Soroban RPC server to check if it's reachable.
 */
export async function pingRpc(): Promise<void> {
  await withRpcReconnect((server) => server.getNetwork());
}

/**
 * Retrieves the current collateral balance for a bond directly from the Soroban contract.
 * @param stellarAddress The importer's Stellar address.
 * @returns The on-chain collateral balance as a string.
 */
export async function getBondOnChain(stellarAddress: string): Promise<string> {
  // Use the contractClient proxy which already has metric instrumentation.
  const acct = await contractClient.getAccount(stellarAddress);
  return acct.collateralBalance.toString();
}

/**
 * Retrieves the current required collateral for a bond directly from the Soroban contract.
 * @param stellarAddress The importer's Stellar address.
 * @returns The on-chain required collateral as a string.
 */
export async function getRequiredCollateralOnChain(stellarAddress: string): Promise<string> {
  const acct = await contractClient.getAccount(stellarAddress);
  return acct.requiredCollateral.toString();
}

/**
 * Emergency override for collateral requirements, bypassing staleness and rate limits (#332).
 */
export async function emergencySetRequiredCollateral(
  importer: string,
  newRequired: bigint
): Promise<void> {
  await contractClient.setRequiredCollateral(
    [emergencyOracleKeypair],
    importer,
    newRequired,
    undefined,
    true, // bypassRateLimit
    true // emergency
  );
}
