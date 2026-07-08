import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRV = process.env.SMOKE_SRV_URL;
const APP = process.env.SMOKE_BASE_URL;
const RUN = !!SRV && !!APP;

// (#1089) Row count derived from the seed CSV directly (no exported JS
// constant exists for the Categories vocabulary). Same CSV the HDI deployer
// picks up. See docs/developers/reference/test-hygiene.md.
const CATEGORY_ROW_COUNT = (() => {
  try {
    const csv = readFileSync(
      join(import.meta.dirname, '../../db/data/com.sap.developers.ims-Categories.csv'),
      'utf8',
    );
    return csv.trim().split(/\r?\n/).length - 1;   // minus header
  } catch {
    return null;   // stay soft; the smoke test itself is env-gated
  }
})();

(RUN ? describe : describe.skip)('smoke: /browse/ Categories facet', () => {
  it('GET /build/catalog includes categorySlugs[] and top-level categories[]', async () => {
    const r = await fetch(`${SRV}/build/catalog`);
    expect(r.ok).toBe(true);
    const j = await r.json();
    expect(Array.isArray(j.categories)).toBe(true);
    expect(j.categories.length).toBe(CATEGORY_ROW_COUNT);
    expect(j.categories[0]).toHaveProperty('slug');
    expect(j.categories[0]).toHaveProperty('activeCount');
    // Confirm at least one card kind has categorySlugs (defensively — empty catalog still ok)
    const someCard = (j.missions?.[0]) || (j.tutorials?.[0]) || (j.standaloneGroups?.[0]);
    if (someCard) {
      expect(someCard).toHaveProperty('categorySlugs');
    }
  });

  it('GET /browse/?category=artificial-intelligence renders the rail group', async () => {
    const r = await fetch(`${APP}/browse/?category=artificial-intelligence`);
    expect(r.ok).toBe(true);
    const html = await r.text();
    expect(html).toMatch(/data-group="categories"/);
  });
});
