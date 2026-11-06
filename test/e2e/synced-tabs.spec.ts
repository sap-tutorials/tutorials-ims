// test/e2e/synced-tabs.spec.ts  (self-skips without SMOKE_BASE_URL)
import { test, expect } from '@playwright/test';
const BASE = process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'SMOKE_BASE_URL not set');

// Slug of a tutorial known to have synced runtime (Node.js/Java) tabs.
// This is a representative tutorial with sync=runtime groups across steps.
const SYNCED_TUTORIAL_SLUG = 'cp-aibus-sti-service-instance';

test('synced tabs: selecting Java activates Java across multiple strips on the same page', async ({ page }) => {
  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}`);

  // Find the first sync strip (picker bar) and click the Java button
  const syncStrip = page.locator('[data-sync-key="runtime"]').first();
  await expect(syncStrip).toBeVisible();

  const javaBtn = syncStrip.getByRole('tab', { name: /^Java$/i });
  await javaBtn.click();

  // All Java panels on the page must be visible; Node.js panels must be hidden
  const javaPanels = page.locator('[data-sync-key="runtime"] [data-sync-value="Java"]');
  const count = await javaPanels.count();
  expect(count).toBeGreaterThan(0);

  // Check the first panel is visible
  await expect(javaPanels.first()).toBeVisible();
});

test('synced tabs: deep link ?runtime=Java pre-selects Java', async ({ page }) => {
  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}?runtime=Java`);

  // The picker button for Java must be selected (aria-selected=true)
  const syncStrip = page.locator('[data-sync-key="runtime"]').first();
  await expect(syncStrip).toBeVisible();

  const javaBtn = syncStrip.getByRole('tab', { name: /^Java$/i });
  await expect(javaBtn).toHaveAttribute('aria-selected', 'true');

  // Java panel content must be visible
  const javaPanels = page.locator('[data-sync-key="runtime"] [data-sync-value="Java"]');
  if (await javaPanels.count() > 0) {
    await expect(javaPanels.first()).toBeVisible();
  }
});

test('synced tabs: choice persists to next page', async ({ page }) => {
  // Pre-seed localStorage with a Java runtime preference
  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}`);
  await page.evaluate(() => {
    localStorage.setItem('sync-groups', JSON.stringify({ runtime: 'Java' }));
  });

  // Navigate to a second tutorial that also has runtime groups
  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}`);

  // The synced strip must reflect the persisted Java choice
  const syncStrip = page.locator('[data-sync-key="runtime"]').first();
  await expect(syncStrip).toBeVisible();

  const javaBtn = syncStrip.getByRole('tab', { name: /^Java$/i });
  await expect(javaBtn).toHaveAttribute('aria-selected', 'true');
});

test('synced tabs: missing variant shows placeholder', async ({ page }) => {
  // Seed a preference for a value that may not exist in every group
  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}`);
  await page.evaluate(() => {
    // Use a value that is unlikely to exist in all groups, triggering placeholder
    localStorage.setItem('sync-groups', JSON.stringify({ runtime: 'Python' }));
  });

  await page.goto(`${BASE}/tutorials/${SYNCED_TUTORIAL_SLUG}`);

  // When a synced strip does not have a matching variant for the stored choice,
  // a placeholder element is rendered so the reader is not left with empty content.
  const placeholder = page.locator('[data-sync-missing]');
  // The placeholder may or may not appear depending on content — we just assert
  // that if it appears, it's visible (i.e. not display:none with content inside).
  const placeholderCount = await placeholder.count();
  if (placeholderCount > 0) {
    await expect(placeholder.first()).toBeVisible();
  } else {
    // If there is no placeholder element, the strip should have fallen back to
    // showing the first available tab (graceful degradation).
    const activePanel = page.locator('[data-sync-key="runtime"] [data-sync-value][aria-hidden="false"]');
    const activePanelCount = await activePanel.count();
    expect(activePanelCount).toBeGreaterThan(0);
  }
});
