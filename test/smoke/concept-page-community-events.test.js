// test/smoke/concept-page-community-events.test.js
//
// Phase 4.8 (#765): smoke test — verifies that the concept-page community-events
// section (section #10) is present in the deployed HTML after seeding.
// Runs against SMOKE_BASE_URL (approuter); skipped when env var is absent.

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const CONCEPT = process.env.SMOKE_CONCEPT_SLUG ?? 'cap-cds-modeling';

describe.skipIf(!BASE)('concept-page community-events section', () => {
  it(`renders section #10 wrapper for concept ${CONCEPT}`, async () => {
    const res = await fetch(`${BASE}/concepts/${CONCEPT}/`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    // The section wrapper must be present in the HTML — it is always emitted
    // by the Hugo template once at least one event is linked. At seed time the
    // section may be empty; we only assert the data-kg-section attribute exists.
    expect(html).toContain('data-kg-section="community-events"');
  });
});
