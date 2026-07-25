// k6 load test: GET /importers/:id (issue #265)
// Target: p95 < 150ms, error rate < 0.1% at 50 VUs.
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, registerTestImporter } from "./lib/setup.js";

export const options = {
  vus: 50,
  duration: "1m",
  thresholds: {
    http_req_duration: ["p(95)<150"],
    http_req_failed: ["rate<0.001"],
  },
};

export function setup() {
  return registerTestImporter();
}

export default function (data) {
  const res = http.get(`${BASE_URL}/importers/${data.importerId}`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "has onChainAccount": (r) => r.json("onChainAccount") !== undefined,
  });
}
