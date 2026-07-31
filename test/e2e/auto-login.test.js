// e2e: automatic login attempt on first connect (homepage exempt).
// Path: browser → approuter static page → inline header.html checkAuth →
// maybeAutoLogin → /login redirect (or none, on the homepage).
//
// Credential-free cases (anonymous) are the core assertions and run with just
// PLAYWRIGHT_BASE_URL. The /login navigation is intercepted+aborted so the test
// never touches the external SAP IDP. Reuses the stable HANA-served slug from
// tutorial-serve.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

describe.skipIf(!hasBaseUrl())('e2e: auto-login on first connect', () => {
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
    await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
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

  it('a deep link auto-redirects an anonymous visitor to /login and sets the tried flag', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    // Intercept the /login navigation so we never reach the external IDP.
    await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
    try {
      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      // maybeAutoLogin fires from checkAuth's finally after /auth/user resolves 401.
      await page.waitForTimeout(3000);
      expect(loginHit, 'anonymous deep link must trigger a /login redirect').toBe(true);
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
      await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
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
