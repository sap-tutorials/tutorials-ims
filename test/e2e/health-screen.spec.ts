// test/e2e/health-screen.spec.ts  (self-skips without SMOKE_BASE_URL)
import { test, expect } from '@playwright/test';
const BASE = process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'SMOKE_BASE_URL not set');
test('health screen renders both tabs', async ({ page }) => {
  await page.goto(`${BASE}/admin-ui/#health`);
  await expect(page.getByText('URL Status')).toBeVisible();
  await expect(page.getByText('Membership Issues')).toBeVisible();
});
