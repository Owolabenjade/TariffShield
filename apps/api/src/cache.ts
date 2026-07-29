import Redis from "ioredis";
import pino from "pino";
import client from "prom-client";
import { env } from "./config/env.js";

// #246 — Redis cache layer for on-chain account state (Soroban RPC reads are
// 200-600ms; this serves repeat GET /importers/:id reads from Redis instead).
//
// A dedicated connection (rather than reusing queue.ts's BullMQ connection)
// keeps this concern isolated: BullMQ requires `maxRetriesPerRequest: null` /
// `enableReadyCheck: false` for its blocking commands, neither of which is
// appropriate for a plain cache client, and a queue-side connection issue
// should not be able to take caching down (or vice versa) — same isolation
// principle `db.ts` already applies with its own dedicated `Pool`.
const logger = pino({ name: "cache" });

// Every call site below already fails open on a Redis error (see
// getCachedOnChainAccount/setCachedOnChainAccount/invalidateOnChainAccount),
// but that only helps if the failure surfaces quickly. ioredis's defaults
// (maxRetriesPerRequest: 20, offline commands queued rather than rejected)
// are tuned for "wait for Redis to come back," which is wrong for a cache on
// the request path — verified against a genuinely unreachable Redis that a
// single `get` took ~12.6s to fail open with the defaults, far past the
// issue's 600ms cache-miss budget. `maxRetriesPerRequest: 1` and
// `enableOfflineQueue: false` make an unavailable Redis fail (and therefore
// fail open) in milliseconds instead.
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
});

// ioredis emits "error" on every failed connection attempt; without a
// listener, Node treats an unhandled "error" event on an EventEmitter as
// fatal and crashes the process. Cache reads/writes below already fail open,
// so a Redis outage should only cost latency (live RPC fallback), never
// bring the API down.
redis.on("error", (err) => {
  logger.error({ err }, "Redis cache connection error");
});

export const cacheOperationsTotal = new client.Counter({
  name: "cache_operations_total",
  help: "Total number of on-chain account cache operations",
  labelNames: ["operation", "result"],
});

export const cacheOperationDurationSeconds = new client.Histogram({
  name: "cache_operation_duration_seconds",
  help: "Duration of on-chain account cache operations in seconds",
  labelNames: ["operation"],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
});

const ON_CHAIN_ACCOUNT_TTL_SECONDS = 30;

/** Shape cached for GET /importers/:id — the fields the route already reads off the Soroban account. */
export interface OnChainAccountView {
  bondId: string;
  collateralBalance: string;
  requiredCollateral: string;
  reserveBalance: string;
  yieldAccrued: string;
  isClawbacked: boolean;
}

export function onChainAccountCacheKey(importerId: string): string {
  return `onchain:importer:${importerId}`;
}

/**
 * Cache-aside read. Returns null on a miss (cold, expired, or invalidated)
 * as well as on any Redis error — callers fall back to the live Soroban RPC
 * read in both cases, so a cache outage degrades latency, not correctness.
 */
export async function getCachedOnChainAccount(
  importerId: string,
): Promise<OnChainAccountView | null> {
  const key = onChainAccountCacheKey(importerId);
  const endTimer = cacheOperationDurationSeconds.startTimer({ operation: "get" });
  try {
    const raw = await redis.get(key);
    endTimer();
    if (raw === null) {
      cacheOperationsTotal.inc({ operation: "get", result: "miss" });
      return null;
    }
    cacheOperationsTotal.inc({ operation: "get", result: "hit" });
    return JSON.parse(raw) as OnChainAccountView;
  } catch (err) {
    endTimer();
    cacheOperationsTotal.inc({ operation: "get", result: "error" });
    logger.warn({ err, key }, "cache get failed; falling back to live RPC read");
    return null;
  }
}

/** Populates the cache after a live RPC read. Never throws — a failed write just means the next read misses too. */
export async function setCachedOnChainAccount(
  importerId: string,
  value: OnChainAccountView,
): Promise<void> {
  const key = onChainAccountCacheKey(importerId);
  const endTimer = cacheOperationDurationSeconds.startTimer({ operation: "set" });
  try {
    await redis.set(key, JSON.stringify(value), "EX", ON_CHAIN_ACCOUNT_TTL_SECONDS);
    cacheOperationsTotal.inc({ operation: "set", result: "success" });
  } catch (err) {
    cacheOperationsTotal.inc({ operation: "set", result: "error" });
    logger.warn({ err, key }, "cache set failed; live data was already served to the caller");
  } finally {
    endTimer();
  }
}

/**
 * Invalidates the cached on-chain account for an importer. Called on every
 * write that changes on-chain balance/required-collateral/clawback state, so
 * the next GET is forced back to a live RPC read instead of serving stale
 * cached state. Never throws — the 30s TTL is the safety net if a Redis
 * hiccup drops an invalidation.
 */
export async function invalidateOnChainAccount(importerId: string): Promise<void> {
  const key = onChainAccountCacheKey(importerId);
  const endTimer = cacheOperationDurationSeconds.startTimer({ operation: "del" });
  try {
    await redis.del(key);
    cacheOperationsTotal.inc({ operation: "del", result: "success" });
  } catch (err) {
    cacheOperationsTotal.inc({ operation: "del", result: "error" });
    logger.error({ err, key }, "cache invalidation failed; stale data may be served until the 30s TTL expires");
  } finally {
    endTimer();
  }
}
