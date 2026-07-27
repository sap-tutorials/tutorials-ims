// Shared config for the Playwright-driven `e2e` project (#1338).
// Mirrors test/smoke/smoke.config.js so the e2e tier reuses the same
// GitHub-secret-backed env vars smoke already relies on — no new secrets.
//
// URL precedence:
//   PLAYWRIGHT_BASE_URL  explicit e2e override (local run against a deployed env)
//   SMOKE_BASE_URL       reused when e2e runs alongside smoke in the same CI job
//   http://localhost:5000  local approuter default (npm run dev:hybrid)

function stripTrailingSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

export const BASE_URL = stripTrailingSlash(
  process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL || 'http://localhost:5000'
);

export const SRV_URL = stripTrailingSlash(process.env.SMOKE_SRV_URL || BASE_URL);

export const TECH_USER = process.env.SMOKE_TECH_USER;
export const TECH_PASSWORD = process.env.SMOKE_TECH_PASSWORD;

// True only when the tier was pointed at a real deployed approuter. Every spec
// gates on this via describe.skipIf so `npm test` and credential-less local
// runs never launch a browser or hang on a localhost that isn't listening.
export function hasBaseUrl() {
  return Boolean(process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL);
}

export function hasCredentials() {
  return Boolean(TECH_USER && TECH_PASSWORD);
}

// Basic auth against the approuter. Verified against current main: the XSUAA
// routes in approuter/xs-app.json short-circuit their IDP redirect when a
// valid Authorization: Basic header is present (same path test/smoke/
// admin-joule.test.js exercises against BASE_URL). SMOKE_TECH_USER is
// provisioned with the admin/scanner/display scopes at deploy time.
export function authHeader() {
  if (!hasCredentials()) return undefined;
  const token = Buffer.from(`${TECH_USER}:${TECH_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}
