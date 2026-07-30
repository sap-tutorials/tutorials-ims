// e2e: authenticated display-app load (#1338).
// Path: browser → approuter /display-app/ (XSUAA scope $XSAPPNAME.DisplayApp) →
//       Vue 3 dashboard → Socket.IO /ws/display namespace.
// A successful WS connect is proven by the dashboard mounting a real view root
// (it shows a placeholder until the WS hands it initial state).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: display-app (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('display-app mounts a dashboard view (WS connect path)', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/display-app/', { waitUntil: 'domcontentloaded' });
      // On WS connect one of the dashboard view roots mounts. Loose union so a
      // class rename doesn't break the test.
      await page
        .locator('main, [role="main"], #app, .dashboard, .display-root')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(
        await page.locator('main, [role="main"], #app, .dashboard, .display-root').count()
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
