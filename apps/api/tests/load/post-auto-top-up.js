// k6 load test: POST /importers/:id/auto-top-up (issue #265)
//
// The issue's acceptance criteria lists this as "POST /admin/auto-top-up",
// but the actual route (apps/api/src/routes/importers.ts) is
// "POST /importers/:id/auto-top-up" — there is no /admin/auto-top-up route
// in this codebase. This script targets the real route.
//
// Target: p95 < 500ms, error rate < 0.1% at 50 VUs.
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, registerTestImporter } from "./lib/setup.js";

export const options = {
  vus: 50,
  duration: "1m",
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.001"],
  },
};

export function setup() {
  return registerTestImporter();
}

export default function (data) {
  const res = http.post(
    `${BASE_URL}/importers/${data.importerId}/auto-top-up`,
    null,
    { headers: { Authorization: `Bearer ${data.token}` } },
  );
  check(res, {
    "status is 202": (r) => r.status === 202,
    "returns a jobId": (r) => !!r.json("jobId"),
  });
}
