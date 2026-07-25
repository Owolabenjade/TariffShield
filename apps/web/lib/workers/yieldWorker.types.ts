// Typed message contract shared between yieldWorker.ts (worker thread) and
// useYieldProjection.ts (main thread) — issue #260.

export interface YieldProjectionRequest {
  /** Current posted collateral balance, in stroops (1 XLM = 1e7 stroops). */
  currentBalanceStroops: string;
  /** Recurring monthly top-up amount, in stroops. */
  monthlyTopUpStroops: string;
  /** Projection horizon in months (1-600). */
  months: number;
  /** Simulated annual yield rate, in basis points (0-10000). */
  annualYieldBps: number;
}

export interface YieldProjectionResponse {
  months: number;
  projectedBalanceStroops: string;
  totalYieldStroops: string;
  monthly: Array<{ month: number; balanceStroops: string }>;
}

export type YieldWorkerMessage =
  | { ok: true; result: YieldProjectionResponse }
  | { ok: false; error: string };
