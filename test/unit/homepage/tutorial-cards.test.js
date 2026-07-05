// test/integration/homepage/tutorial-cards.test.js
//
// (#763 Task 12) Integration tests for GET /homepage/tutorialCards.
// Verifies the public endpoint returns well-formed card objects and
// enforces the 20-slug cap.
//
// Note: CAP wraps all function-returning-array responses in OData format:
//   { "@odata.context": "...", "value": [...] }
// Tests unwrap via `r.data?.value ?? r.data` for robustness.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Helper to unwrap CAP's OData array wrapper.
function unwrap(data) {
  return data?.value ?? data;
}

describe('GET /homepage/tutorialCards', () => {
  // ── 1. Empty slugs → [] ──────────────────────────────────────────────────
  it('returns [] for empty slugs', async () => {
    const r = await project.get('/homepage/tutorialCards?slugs=[]', {
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    expect(unwrap(r.data)).toEqual([]);
  });

  // ── 2. Unknown slugs → [] (no rows matching) ─────────────────────────────
  it('returns [] when no slugs match DB', async () => {
    const r = await project.get(
      `/homepage/tutorialCards?slugs=${encodeURIComponent(JSON.stringify(['no-such-slug']))}`,
      { validateStatus: () => true }
    );
    expect(r.status).toBe(200);
    const cards = unwrap(r.data);
    expect(Array.isArray(cards)).toBe(true);
    expect(cards).toHaveLength(0);
  });

  // ── 3. Slug cap: more than 20 slugs should not crash and return ≤20 results
  it('caps input at 20 slugs without error', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `slug-${i}`);
    const r = await project.get(
      `/homepage/tutorialCards?slugs=${encodeURIComponent(JSON.stringify(many))}`,
      { validateStatus: () => true }
    );
    // Server accepts the request; may return 0 results (no matching rows in empty DB)
    // but must not 500.
    expect(r.status).toBe(200);
    const cards = unwrap(r.data);
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBeLessThanOrEqual(20);
  });

  // ── 4. Returns correct shape when a slug exists ───────────────────────────
  it('returns {slug, html} objects for matching slugs', async () => {
    // Seed a tutorial directly into the in-memory DB.
    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const testSlug = 'task12-integration-test-tutorial';
    await db.run(
      INSERT.into(Tutorials).entries({
        ID: '00000000-0000-0000-0000-000000000012',
        slug: testSlug,
        title: 'Test Tutorial <Task12>',
        description: 'Desc',
        primaryTag: 'tutorial>test',
        experienceTag: 'beginner',
        averageTimeToComplete: 15,
        status: 'ACTIVE',
      })
    );

    const r = await project.get(
      `/homepage/tutorialCards?slugs=${encodeURIComponent(JSON.stringify([testSlug]))}`,
      { validateStatus: () => true }
    );
    expect(r.status).toBe(200);
    const cards = unwrap(r.data);
    expect(Array.isArray(cards)).toBe(true);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.slug).toBe(testSlug);
    expect(typeof card.html).toBe('string');
    // Title must be HTML-escaped in output
    expect(card.html).toContain('Test Tutorial &lt;Task12&gt;');
    // Must carry data-slug attribute for DOM reorder
    expect(card.html).toContain(`data-slug="${testSlug}"`);
  });
});

