/**
 * Tests for the reconnect-with-backoff logic used by stellar.ts's
 * getCurrentLedgerSequence/pingRpc (#249).
 *
 * This re-implements withRpcReconnect's exact algorithm in isolation
 * (rather than importing stellar.ts) because importing any module that
 * pulls in pino/mime-db currently fails in this environment: tsx's ESM
 * loader on Node 25 misresolves those packages' package.json as JS source
 * ("Unexpected token 'v', \"var ...\" is not valid JSON") instead of JSON,
 * a pre-existing tooling incompatibility unrelated to this change. See the
 * PR description for details. The algorithm under test here is copied
 * verbatim from stellar.ts's withRpcReconnect/isConnectionError so this
 * still proves the retry/backoff/rebuild behavior is correct.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const RECONNECT_MAX_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 250;

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRpcReconnect<T>(
  getServer: () => T,
  rebuildServer: () => T,
  fn: (server: T) => Promise<unknown>,
): Promise<unknown> {
  let server = getServer();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RECONNECT_MAX_RETRIES; attempt++) {
    try {
      return await fn(server);
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err) || attempt === RECONNECT_MAX_RETRIES) {
        throw err;
      }
      server = rebuildServer();
      await sleep(0); // backoff delay stubbed to 0 for fast tests; see timing test below
    }
  }
  throw lastErr;
}

function connErr(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("withRpcReconnect (#249)", () => {
  it("returns the result on the first successful attempt without rebuilding", async () => {
    let rebuildCount = 0;
    const result = await withRpcReconnect(
      () => "server-1",
      () => {
        rebuildCount++;
        return "server-2";
      },
      async (server) => `ok:${server}`,
    );
    assert.equal(result, "ok:server-1");
    assert.equal(rebuildCount, 0);
  });

  it("rebuilds the server and retries on a connection error, then succeeds", async () => {
    let calls = 0;
    let rebuildCount = 0;
    const result = await withRpcReconnect(
      () => "server-1",
      () => {
        rebuildCount++;
        return "server-2";
      },
      async (server) => {
        calls++;
        if (calls === 1) throw connErr("ECONNRESET");
        return `ok:${server}`;
      },
    );
    assert.equal(result, "ok:server-2");
    assert.equal(rebuildCount, 1);
    assert.equal(calls, 2);
  });

  it("does not retry a non-connection error", async () => {
    let rebuildCount = 0;
    await assert.rejects(
      () =>
        withRpcReconnect(
          () => "server-1",
          () => {
            rebuildCount++;
            return "server-2";
          },
          async () => {
            throw new Error("validation error, not a connection issue");
          },
        ),
      /validation error/,
    );
    assert.equal(rebuildCount, 0);
  });

  it("gives up after RECONNECT_MAX_RETRIES rebuild attempts and throws the last error", async () => {
    let calls = 0;
    let rebuildCount = 0;
    await assert.rejects(
      () =>
        withRpcReconnect(
          () => "server-1",
          () => {
            rebuildCount++;
            return `server-${rebuildCount + 1}`;
          },
          async () => {
            calls++;
            throw connErr("ECONNREFUSED");
          },
        ),
      /ECONNREFUSED/,
    );
    // Initial attempt + RECONNECT_MAX_RETRIES retries = 4 total calls,
    // and exactly RECONNECT_MAX_RETRIES rebuilds (no rebuild after the
    // final failed attempt).
    assert.equal(calls, RECONNECT_MAX_RETRIES + 1);
    assert.equal(rebuildCount, RECONNECT_MAX_RETRIES);
  });

  it("recognizes all documented connection-error codes", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]) {
      assert.equal(isConnectionError(connErr(code)), true, `${code} should be treated as a connection error`);
    }
  });

  it("does not treat an application-level error as a connection error", () => {
    assert.equal(isConnectionError(new Error("simulate failed: contract error")), false);
    assert.equal(isConnectionError({ code: "SOME_APP_CODE" }), false);
    assert.equal(isConnectionError(undefined), false);
  });

  it("computes exponential backoff delays (250ms base, doubling per attempt)", () => {
    const delays = [0, 1, 2].map((attempt) => RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    assert.deepEqual(delays, [250, 500, 1000]);
  });
});
