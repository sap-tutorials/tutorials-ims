// test/unit/content/render-mission-unavailable.test.js
//
// Task 5 (#2864) — verify that renderMissionBody greys out, delinks, badges,
// and tooltips tutorial cards whose `temporarilyUnavailable` flag is set.
//
// Three cases:
//  1. flagged + reason (contains `&` to exercise escaping)
//  2. flagged, reason null/undefined
//  3. not flagged — regression: normal anchor still present
//
// Import via relative path so the test resolves against the worktree's
// packages/content/, NOT the @tutorials/content workspace alias (which points
// at the primary checkout).

import { describe, it, expect } from 'vitest';
import { renderMissionBody } from '../../../packages/content/catalog-renderer.js';

// Minimal valid ctx — mirrors the shape used in test/catalog-renderer.test.js.
// Only the fields the renderer touches are required.
const baseMission = {
  mission: { ID: 'm1', slug: 'test-mission', title: 'Test Mission', description: '' },
  groupCount: 1,
  tutorialCount: 2,
  totalTime: 15,
  level: 'beginner',
};

const baseGroup = {
  ID: 'g1',
  slug: 'g-one',
  title: 'G One',
  isSynthetic: false,
};

describe('renderMissionBody — temporarilyUnavailable path items (#2864)', () => {
  it('flagged tutorial with reason: delinked, badge present, reason escaped in title/aria-label', () => {
    const ctx = {
      ...baseMission,
      groups: [
        {
          ...baseGroup,
          tutorials: [
            {
              slug: 'tut-flagged',
              title: 'Flagged Tutorial',
              level: 'beginner',
              time: 5,
              stepCount: 2,
              temporarilyUnavailable: true,
              unavailableReason: 'Down & out',
            },
            {
              slug: 'tut-normal',
              title: 'Normal Tutorial',
              level: 'intermediate',
              time: 10,
              stepCount: 3,
              temporarilyUnavailable: false,
            },
          ],
        },
      ],
    };
    const html = renderMissionBody(ctx);

    // 1a. Title text is still visible
    expect(html).toContain('Flagged Tutorial');

    // 1b. No anchor with class="tutorial-link" for the flagged slug
    // The pattern `<a ... class="tutorial-link"` must NOT appear for tut-flagged.
    // We look for the href to be absent too.
    expect(html).not.toMatch(/href="\/tutorials\/tut-flagged[^"]*"\s+class="tutorial-link"/);
    expect(html).not.toMatch(/class="tutorial-link"[^>]*href="\/tutorials\/tut-flagged/);

    // 1c. Badge present
    expect(html).toContain('nav-card__unavailable-badge');
    expect(html).toContain('Temporarily Unavailable');

    // 1d. Reason is HTML-escaped in title and aria-label attributes
    //     '&' in source must become '&amp;' in the attribute value.
    expect(html).toContain('Down &amp; out');
    expect(html).not.toContain('title="Down & out"');
    expect(html).not.toContain('aria-label="Down & out"');

    // 1e. title attribute present with escaped reason
    expect(html).toContain('title="Down &amp; out"');
    // 1f. aria-label attribute present with escaped reason
    expect(html).toContain('aria-label="Down &amp; out"');

    // 1g. Disabled card class present
    expect(html).toContain('tutorial-card--unavailable');
  });

  it('flagged tutorial without reason: badge present, no empty title/title="undefined"', () => {
    const ctx = {
      ...baseMission,
      groups: [
        {
          ...baseGroup,
          tutorials: [
            {
              slug: 'tut-noreason',
              title: 'No Reason Tutorial',
              level: 'beginner',
              time: 5,
              stepCount: 1,
              temporarilyUnavailable: true,
              unavailableReason: undefined,
            },
          ],
        },
      ],
    };
    const html = renderMissionBody(ctx);

    // Badge must still appear
    expect(html).toContain('nav-card__unavailable-badge');
    expect(html).toContain('Temporarily Unavailable');

    // No empty title or title="undefined"
    expect(html).not.toContain('title=""');
    expect(html).not.toContain('title="undefined"');
    expect(html).not.toContain('aria-label=""');
    expect(html).not.toContain('aria-label="undefined"');
  });

  it('flagged tutorial with null reason: badge present, no empty title/title="null"', () => {
    const ctx = {
      ...baseMission,
      groups: [
        {
          ...baseGroup,
          tutorials: [
            {
              slug: 'tut-nullreason',
              title: 'Null Reason Tutorial',
              level: 'beginner',
              time: 5,
              stepCount: 1,
              temporarilyUnavailable: true,
              unavailableReason: null,
            },
          ],
        },
      ],
    };
    const html = renderMissionBody(ctx);

    expect(html).toContain('nav-card__unavailable-badge');
    expect(html).not.toContain('title=""');
    expect(html).not.toContain('title="null"');
    expect(html).not.toContain('aria-label="null"');
  });

  it('not flagged: normal anchor with class="tutorial-link" is present (regression)', () => {
    const ctx = {
      ...baseMission,
      groups: [
        {
          ...baseGroup,
          tutorials: [
            {
              slug: 'tut-normal',
              title: 'Normal Tutorial',
              level: 'intermediate',
              time: 10,
              stepCount: 3,
              temporarilyUnavailable: false,
            },
          ],
        },
      ],
    };
    const html = renderMissionBody(ctx);

    // Normal anchor must be present
    expect(html).toContain('href="/tutorials/tut-normal?from=g-one"');
    expect(html).toContain('class="tutorial-link"');

    // No badge
    expect(html).not.toContain('nav-card__unavailable-badge');
    expect(html).not.toContain('tutorial-card--unavailable');
  });
});
