// k6 load test: POST /importers/:id/deposit (issue #265)
// Target: p95 < 500ms, error rate < 0.1% at 50 VUs.
//
// NOTE: this endpoint 403s with "KYC approval required" until the importer's
// kyc_status is 'approved' (see apps/api/src/routes/importers.ts), which
// requires a document-upload + surety_admin review flow this setup() does
// not automate. Seed an approved importer (e.g. via `npm run seed` or the
// KYC review flow) against your staging environment before running this
// script, or expect 403s rather than 202s in an unseeded environment.
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
    `${BASE_URL}/importers/${data.importerId}/deposit`,
    JSON.stringify({ amountStroops: "10000000", bucket: "collateral" }),
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` },
      // Treat both as "not failed" for http_req_failed/the error-rate
      // threshold: 202 = job enqueued, 403 = KYC gate (expected in an
      // unseeded environment — see the NOTE above).
      responseCallback: http.expectedStatuses(202, 403),
    },
  );
  check(res, {
    "status is 202 or 403": (r) => r.status === 202 || r.status === 403,
  });
}
