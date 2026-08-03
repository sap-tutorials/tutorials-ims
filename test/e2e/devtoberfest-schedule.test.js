// e2e: Devtoberfest schedule / sessions / calendar pages + public feed.
// Three Vue-island pages served at /devtoberfest/schedule/, /devtoberfest/sessions/,
// and /devtoberfest/calendar/. Islands mount into <main> tags with matching IDs.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/devtoberfest-schedule.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest schedule pages', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  // ── 1. Schedule table ────────────────────────────────────────────────────
  it('anonymous /devtoberfest/schedule/ renders a table or empty-state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/schedule/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> (never <article>), #1338.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island mounts into #devtoberfest-schedule-mount; wait for hydration.
      await page.locator('#devtoberfest-schedule-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // A fresh/empty DEV edition legitimately renders no rows.
      // Accept either: a <table> is visible, OR a visible empty-state text.
      const tableCount = await page.locator('table').count();
      const emptyState = await page.getByText(/no sessions|no activities|no results|nothing scheduled/i).count();
      expect(
        tableCount > 0 || emptyState > 0,
        'schedule page should render a table or an empty-state message'
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // ── 2. Sessions grid ──────────────────────────────────────────────────────
  it('anonymous /devtoberfest/sessions/ renders a cards container or empty-state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/sessions/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('#devtoberfest-sessions-grid-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // Accept a card/article element OR an empty-state message.
      const cardCount = await page.locator('[class*="card"], [class*="session"], article').count();
      const emptyState = await page.getByText(/no sessions|nothing here|no results/i).count();
      expect(
        cardCount > 0 || emptyState > 0,
        'sessions page should render cards or an empty-state message'
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // ── 3. Sessions calendar ──────────────────────────────────────────────────
  it('anonymous /devtoberfest/calendar/ renders a calendar grid or empty-state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/calendar/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('#devtoberfest-sessions-calendar-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // Accept a grid/table structure OR an empty-state message.
      const gridCount = await page.locator('[class*="calendar"], [class*="grid"], table').count();
      const emptyState = await page.getByText(/no sessions|nothing scheduled|no results/i).count();
      expect(
        gridCount > 0 || emptyState > 0,
        'calendar page should render a grid or an empty-state message'
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // ── 4. Public feed endpoint ───────────────────────────────────────────────
  it('public /api/devtoberfest/schedule returns 200+JSON or 503 EVENT_NOT_CONFIGURED', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Use context.request (Playwright APIRequestContext) to avoid CORS/browser
      // fetch restrictions; falls back to page.evaluate if not available.
      let status, body;
      if (context.request) {
        const res = await context.request.get('/api/devtoberfest/schedule');
        status = res.status();
        if (status === 200) {
          body = await res.json();
        }
      } else {
        // Fallback: in-page fetch (same-origin — no CORS issue against approuter).
        ({ status, body } = await page.evaluate(async () => {
          const r = await fetch('/api/devtoberfest/schedule');
          return { status: r.status, body: r.ok ? await r.json() : null };
        }));
      }

      // DEV may have no active edition → 503 EVENT_NOT_CONFIGURED is valid.
      // A configured edition must return 200 + the expected shape.
      expect(
        status === 200 || status === 503,
        `feed should return 200 or 503, got ${status}`
      ).toBe(true);

      if (status === 200 && body) {
        expect(body, 'feed response should be an object').toBeTypeOf('object');
        expect(Array.isArray(body.sessions), 'feed.sessions should be an array').toBe(true);
        expect(Array.isArray(body.activities), 'feed.activities should be an array').toBe(true);
        expect(Array.isArray(body.editions), 'feed.editions should be an array').toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  // ── 5. Zone-labeled session times (verifies timezone-aware rendering) ───────
  it('schedule page renders session times with a timezone label when rows are present', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/schedule/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('#devtoberfest-schedule-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // Collect all table-cell texts that contain a time-like pattern (HH:MM).
      // A fresh / unpublished DEV edition renders no rows → skip the zone assertion.
      const timeCellTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('td'))
          .map(td => td.textContent?.trim() ?? '')
          .filter(text => /\d{1,2}:\d{2}/.test(text))
      );

      if (timeCellTexts.length === 0) {
        // Empty-state tolerance: no sessions rendered; zone check is N/A.
        return;
      }

      // At least one time cell is present — assert it carries a timezone-name token,
      // proving viewer-local + zone-label rendering shipped (not a bare HH:MM naive string).
      // Matches: GMT+2, GMT-5, CEST, EST, PDT, BST, UTC, etc.
      const zoneTokenRe = /GMT[+-]\d{1,2}|[A-Z]{2,5}T\b|\bUTC\b/;
      const hasZone = timeCellTexts.some(text => zoneTokenRe.test(text));
      expect(
        hasZone,
        `no timezone label found in time cells: ${JSON.stringify(timeCellTexts.slice(0, 3))}`
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // ── 6. Logged-in points banner (optional — skips without credentials) ─────
  it.skipIf(!hasCredentials())('authenticated /devtoberfest/schedule/ shows a points banner or sign-in prompt', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.goto('/devtoberfest/schedule/', { waitUntil: 'domcontentloaded' });
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('#devtoberfest-schedule-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // Either a points/earned banner is visible, or the page still shows a sign-in
      // prompt (depends on XSUAA routing for the tech user's scopes).
      const pointsBanner = await page.getByText(/earned|points|score/i).count();
      const signInPrompt = await page.getByText(/sign in|log in|login/i).count();
      expect(
        pointsBanner > 0 || signInPrompt > 0,
        'authenticated schedule page should show a points banner or a sign-in prompt'
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
