// test/load/config.js
// Central config for all k6 scenarios. Threshold values live here only —
// never hardcode ms values in scenario files.

const DEFAULT_BASE_URL =
  'https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com';

// __ENV is k6's env-var namespace. Empty string counts as unset.
function envOr(name, fallback) {
  const v = __ENV[name];
  return v && v.length > 0 ? v : fallback;
}

function envInt(name, fallback) {
  const v = __ENV[name];
  if (!v || v.length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const BASE_URL = envOr('LOAD_BASE_URL', DEFAULT_BASE_URL);
// If LOAD_SRV_URL not set, derive from BASE_URL by inserting `-tutorials-srv`
// in place of `-tutorials-approuter`. AppRouter and srv are separate CF apps
// in DEV; /build/* is served by srv.
const SRV_URL = envOr(
  'LOAD_SRV_URL',
  BASE_URL.replace('-tutorials-approuter', '-tutorials-srv'),
);
const SUMMARY_PATH = envOr('LOAD_SUMMARY_PATH', 'k6-summary.json');
const MODE = envOr('LOAD_MODE', 'cold');

// Threshold table. Keys map to `endpoint` tag values stamped on requests
// by lib/http.js. k6 evaluates these at the end of the run and exits
// non-zero if any is violated.
const THRESHOLDS = {
  // Global smoke ceiling.
  'http_req_failed{scenario:smoke}': ['rate<0.01'],

  // Baseline scenario (Task 3).
  'http_req_duration{endpoint:build-catalog}': ['p(95)<500'],
  'http_req_duration{endpoint:build-navigator}': ['p(95)<500'],
  'http_req_duration{endpoint:tutorial}': ['p(95)<300'],
  'http_req_duration{endpoint:advocates-list}': ['p(95)<200'],
  'http_req_duration{endpoint:advocates-photo}': ['p(95)<300'],
  'http_req_failed{endpoint:build-catalog}': ['rate<0.01'],
  'http_req_failed{endpoint:build-navigator}': ['rate<0.01'],
  'http_req_failed{endpoint:tutorial}': ['rate<0.01'],
  'http_req_failed{endpoint:advocates-list}': ['rate<0.005'],
  'http_req_failed{endpoint:advocates-photo}': ['rate<0.005'],

  // Ramp scenario is 2× baseline (softer; see spec section 3).
  'http_req_duration{scenario:ramp,endpoint:tutorial}': ['p(95)<600'],
  'http_req_duration{scenario:ramp,endpoint:build-catalog}': ['p(95)<1000'],

  // Tutorial-serve scenario (cache modes).
  'http_req_duration{scenario:tutorial-serve,mode:hot}': ['p(95)<150'],
  'http_req_duration{scenario:tutorial-serve,mode:cold}': ['p(95)<500'],

  // WebSocket handshake.
  'ws_connecting{scenario:ws}': ['p(95)<1000'],
  'ws_session_errors{scenario:ws}': ['rate<0.02'],
};

function tagsFor(endpoint) {
  return { endpoint };
}

export {
  BASE_URL,
  SRV_URL,
  SUMMARY_PATH,
  MODE,
  THRESHOLDS,
  envInt,
  tagsFor,
};
