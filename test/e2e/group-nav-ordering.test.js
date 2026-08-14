// e2e: group tutorial navigation stays in-group (#group-nav ordering).
// Entering the 3rd tutorial from the group page must Next → the 4th tutorial
// in the SAME group, not out to another mission's group.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/group-nav-ordering.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const GROUP = 'set-up-your-sap-hana-cloud-sap-hana-database-and-understand-the-basics';
const THIRD = 'hana-cloud-mission-trial-3';
const FOURTH = 'hana-cloud-mission-trial-4';
// #1775: FOURTH is the last tutorial of GROUP; FIFTH is the first tutorial of
// the NEXT group in the same mission ("Jump Start…"). Next must continue there.
const NEXT_GROUP = 'take-your-first-steps-with-sap-hana-cloud-sap-hana-database';
const FIFTH = 'hana-cloud-mission-trial-5';

describe.skipIf(!hasBaseUrl())('e2e: group nav stays in-group', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('group page tags tutorial links with ?from=<group>', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/group-${GROUP}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      const href = await page.locator(`a[href*="/tutorials/${THIRD}"]`).first().getAttribute('href');
      expect(href, 'group link must carry ?from=').toContain(`?from=${GROUP}`);
    } finally { await context.close(); }
  });

  it('Next on the 3rd tutorial (entered from the group) lands on the 4th in-group', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/${THIRD}?from=${GROUP}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      // Island rewrites the baked Next; poll until the href points in-group.
      await expect
        .poll(async () => page.locator('.tutorial-nav-bottom a.nav-pill--primary').first().getAttribute('href'),
          { timeout: 20_000 })
        .toContain(`/tutorials/${FOURTH}`);
    } finally { await context.close(); }
  });

  it('#1775: Next on the last tutorial of a group continues into the next group of the same mission (baked default, no ?from=)', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/${FOURTH}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      const href = await page.locator('.tutorial-nav-bottom a.nav-pill--primary').first().getAttribute('href');
      expect(href, 'last-in-group Next must link to the first tutorial of the next group').toContain(`/tutorials/${FIFTH}`);
    } finally { await context.close(); }
  });

  it('#1775: Next across the group boundary (entered from the group) lands on the next group and carries its ?from=', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const res = await page.goto(`/tutorials/${FOURTH}?from=${GROUP}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      await expect
        .poll(async () => page.locator('.tutorial-nav-bottom a.nav-pill--primary').first().getAttribute('href'),
          { timeout: 20_000 })
        .toContain(`/tutorials/${FIFTH}?from=${NEXT_GROUP}`);
    } finally { await context.close(); }
  });
});
