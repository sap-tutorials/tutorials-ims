// e2e: tutorial-step-pacing — optional-step Skip completes the tutorial, and
// interactive checklist state persists across reload.
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so `npm test`
// (unit suite) and credential-less local runs are unaffected, AND when SLUG
// below hasn't been populated yet (no tutorial using the `{time=…}`/
// `{optional}` syntax has been published at the time this spec was written).
//
// SLUG: update this once a published tutorial exists with:
//   - at least one step heading `{optional}` (completable without it)
//   - at least one GFM task list (`- [ ] …`) inside a step
// e.g. `### Enable the trial entitlement {time=2m optional}` followed later by
// a checklist step. See docs/authors/writing-tutorials.md §3.3.1/3.3.2.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

/** A tutorial that declares at least one `{optional}` step and one task list. */
const SLUG = ''; // TODO: populate once a qualifying tutorial is deployed

const TUTORIAL_PATH = `/tutorials/${SLUG}/`;

describe.skipIf(!hasBaseUrl() || !SLUG)('e2e: tutorial-step-pacing (optional steps + checklists)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('skipping the optional step still completes the tutorial', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      // Mark every non-optional step Done; click Skip on the optional one.
      const stepEls = await page.$$('.tutorial-step');
      for (const stepEl of stepEls) {
        const isOptional = await stepEl.getAttribute('data-optional');
        const header = await stepEl.$('.step-header');
        await header?.click(); // expand
        if (isOptional === 'true') {
          const skipBtn = await stepEl.$('[data-action="skip-step"]');
          await skipBtn?.click();
        } else {
          const doneBtn = await stepEl.$('[data-action="mark-done"]');
          await doneBtn?.click();
          await page.waitForFunction(
            (el) => el?.classList.contains('completed'),
            stepEl,
            { timeout: 10_000 },
          );
        }
      }

      // The "completed" banner (tutorial.ts maybeShowCompletedBanner) should
      // appear even though the optional step was never marked Done.
      await page.waitForSelector('[data-banner="completed"]', { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  it('checklist state persists across reload', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      const checkbox = await page.waitForSelector('.task-list-checkbox', { timeout: 10_000 });
      await checkbox.click();
      const counter = await page.waitForSelector('.task-list-counter', { timeout: 5_000 });
      const before = await counter.textContent();
      expect(before).toMatch(/^1\//);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const checkboxAfter = await page.waitForSelector('.task-list-checkbox', { timeout: 10_000 });
      expect(await checkboxAfter.isChecked()).toBe(true);
      const counterAfter = await page.waitForSelector('.task-list-counter', { timeout: 5_000 });
      expect(await counterAfter.textContent()).toBe(before);
    } finally {
      await context.close();
    }
  });
});
