#!/usr/bin/env node
// Formats k6 --summary-export JSON files (apps/api/tests/load/results/*.json)
// into a markdown table for the benchmark.yml PR-comment step (issue #265).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RESULTS_DIR = "apps/api/tests/load/results";

// Targets documented in apps/api/tests/load/README.md
const TARGETS_MS = {
  "get-importers": 200,
  "get-importer-detail": 150,
  "post-deposit": 500,
  "post-withdraw": 500,
  "post-auto-top-up": 500,
};

function fmtMs(v) {
  return typeof v === "number" ? `${v.toFixed(1)}ms` : "—";
}

function fmtPct(v) {
  return typeof v === "number" ? `${(v * 100).toFixed(3)}%` : "—";
}

function main() {
  const lines = ["## k6 Benchmark Results", ""];

  if (!existsSync(RESULTS_DIR)) {
    lines.push("_No results found — the benchmark run did not produce output (see workflow logs)._");
    console.log(lines.join("\n"));
    return;
  }

  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    lines.push("_No results found — the benchmark run did not produce output (see workflow logs)._");
    console.log(lines.join("\n"));
    return;
  }

  lines.push("| Script | p95 | Target | Error rate | Error target | Status |");
  lines.push("|---|---|---|---|---|---|");

  let anyFailed = false;

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    let summary;
    try {
      summary = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8"));
    } catch {
      lines.push(`| ${name} | — | — | — | — | ⚠️ could not parse results |`);
      anyFailed = true;
      continue;
    }

    const p95 = summary.metrics?.http_req_duration?.values?.["p(95)"];
    const errorRate = summary.metrics?.http_req_failed?.values?.rate;
    const targetMs = TARGETS_MS[name];

    const p95Ok = typeof p95 === "number" && typeof targetMs === "number" ? p95 < targetMs : null;
    const errOk = typeof errorRate === "number" ? errorRate < 0.001 : null;
    const ok = p95Ok !== false && errOk !== false;
    if (!ok) anyFailed = true;

    lines.push(
      `| ${name} | ${fmtMs(p95)} | < ${targetMs}ms | ${fmtPct(errorRate)} | < 0.1% | ${ok ? "✅" : "❌"} |`,
    );
  }

  lines.push("");
  lines.push(
    anyFailed
      ? "⚠️ One or more scripts exceeded their p95 latency or error-rate threshold."
      : "✅ All scripts met their p95 latency and error-rate thresholds.",
  );

  console.log(lines.join("\n"));
}

main();
