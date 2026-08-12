// e2e: automatic login attempt for RETURNING visitors (issue #1689).
// Path: browser → approuter static page → inline header.html checkAuth →
// maybeAutoLogin → /login redirect (or none).
//
// Balance (#1689): first-time / no-account visitors are NEVER bounced to the
// SAP IDP login screen. Only browsers that have authenticated here before (the
// durable localStorage 'auth.returning' flag, set on a successful /auth/user
// response) are silently re-logged-in on later sessions. The homepage (/) is
// always exempt.
//
// Credential-free cases (anonymous) are the core assertions and run with just
// PLAYWRIGHT_BASE_URL. The /login navigation is intercepted+aborted so the test
// never touches the external SAP IDP. Reuses the stable HANA-served slug from
// tutorial-serve.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

describe.skipIf(!hasBaseUrl())('e2e: auto-login for returning visitors', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('homepage (/) does NOT auto-redirect an anonymous visitor', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    await page.route(/\/login(\?|$)/, route => { loginHit = true; return route.abort(); });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      // Give the async checkAuth()/maybeAutoLogin() a beat to run.
      await page.waitForTimeout(2000);
      expect(loginHit, 'homepage must not trigger auto-login').toBe(false);
      const tried = await page.evaluate(() => {
        try { return sessionStorage.getItem('autologin.tried'); } catch { return 'ERR'; }
      });
      expect(tried, 'autologin.tried must be unset on the homepage').toBeNull();
    } finally {
      await context.close();
    }
  });

  it('a first-time anonymous visitor on a deep link is NOT auto-redirected (#1689)', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    // Intercept the /login navigation so we never reach the external IDP.
    await page.route(/\/login(\?|$)/, route => { loginHit = true; return route.abort(); });
    try {
      // No 'auth.returning' flag → this browser has never logged in here.
      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      // maybeAutoLogin fires from checkAuth's finally after /auth/user resolves 401.
      await page.waitForTimeout(2000);
      expect(loginHit, 'a first-time anonymous visitor must NOT be bounced to /login').toBe(false);
    } finally {
      await context.close();
    }
  });

  it('a returning anonymous visitor (auth.returning set) IS auto-redirected to /login', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    await page.route(/\/login(\?|$)/, route => { loginHit = true; return route.abort(); });
    // Seed the durable returning-visitor flag before any page script runs.
    await page.addInitScript(() => {
      try { localStorage.setItem('auth.returning', '1'); } catch {}
    });
    try {
      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await page.waitForRequest(/\/login/, { timeout: 10_000 }).catch(() => {});
      expect(loginHit, 'a returning anonymous visitor must trigger a /login redirect').toBe(true);
      const tried = await page.evaluate(() => {
        try { return sessionStorage.getItem('autologin.tried'); } catch { return 'ERR'; }
      });
      expect(tried, 'autologin.tried must be set before redirecting').toBe('1');
    } finally {
      await context.close();
    }
  });

  it.skipIf(!hasCredentials())(
    'an authenticated deep link does NOT navigate to /login', async () => {
      const { context, page } = await newPage(browser, { authenticated: true });
      let loginHit = false;
      await page.route(/\/login(\?|$)/, route => { loginHit = true; return route.abort(); });
      try {
        const response = await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
        expect(response?.status(), 'deep link should load').toBe(200);
        await page.waitForTimeout(2000);
        expect(loginHit, 'authenticated user must not be redirected to /login').toBe(false);
      } finally {
        await context.close();
      }
    }
  );
});
