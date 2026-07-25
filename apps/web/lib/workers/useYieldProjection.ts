"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { YieldProjectionRequest, YieldProjectionResponse, YieldWorkerMessage } from "./yieldWorker.types";

export interface UseYieldProjection {
  result: YieldProjectionResponse | null;
  error: string | null;
  loading: boolean;
  project: (input: YieldProjectionRequest) => void;
}

/**
 * Instantiates the yield-projection WebWorker once per component lifetime
 * and reuses it for every recalculation (issue #260) — postMessage/onmessage
 * round-trips instead of a synchronous main-thread calculation, so typing
 * into the projection inputs never blocks rendering.
 */
export function useYieldProjection(): UseYieldProjection {
  const workerRef = useRef<Worker | null>(null);
  const [result, setResult] = useState<YieldProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL("./yieldWorker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<YieldWorkerMessage>) => {
      setLoading(false);
      if (event.data.ok) {
        setResult(event.data.result);
        setError(null);
      } else {
        setError(event.data.error);
      }
    };

    worker.onerror = (event) => {
      setLoading(false);
      setError(event.message || "yield projection worker crashed");
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const project = useCallback((input: YieldProjectionRequest) => {
    const worker = workerRef.current;
    if (!worker) return;
    setLoading(true);
    setError(null);
    worker.postMessage(input);
  }, []);

  return { result, error, loading, project };
}
