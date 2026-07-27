// Shared browser lifecycle + auth for e2e specs (#1338).
//
// Uses `playwright-core` + `chromium.launch()` inside plain vitest — the exact
// pattern test/a11y/axe.test.js already runs in CI (the `a11y` project).
// Deliberately NOT `@playwright/test`: that would add a second test runner and
// a new dependency for zero benefit here, since vitest is already the harness.
//
// Auth model: a context is created with the Basic Authorization header baked in
// (when credentials are present), which short-circuits the approuter's XSUAA
// IDP redirect. Auth state is never written to disk.

import { chromium } from 'playwright-core';
import { BASE_URL, authHeader, hasCredentials } from './e2e.config.js';

export function requireCredentials() {
  if (!hasCredentials()) {
    throw new Error(
      'e2e authenticated spec requires SMOKE_TECH_USER and SMOKE_TECH_PASSWORD. ' +
      'Locally: export them before `npm run test:e2e`. In CI they come from the ' +
      'SMOKE_TECH_USER / SMOKE_TECH_PASSWORD repo secrets (same as smoke). If they ' +
      'were set and this still fails, check secret rotation.'
    );
  }
}

// Launch a headless Chromium. Call once per spec file in beforeAll; close in
// afterAll. Matches axe.test.js's --with-deps chromium install in CI.
export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

// Create a fresh context (+ page) with the Basic auth header applied when
// credentials exist. `authenticated: false` yields an anonymous context for the
// unauthenticated tutorial-serve path.
export async function newPage(browser, { authenticated = true } = {}) {
  const extraHTTPHeaders =
    authenticated && hasCredentials() ? { Authorization: authHeader() } : {};
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders });
  const page = await context.newPage();
  return { context, page };
}
