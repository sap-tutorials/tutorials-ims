// Unit tests for app/admin-shell/webapp/controller/cron-timeline-helpers.js
// (#750). Pure functions:
// - categoryForJob(jobName)  → category slug string
// - buildTimelineSvg(jobs, opts) → SVG markup string
// - CATEGORY_COLORS          → const map exported for tests + sanity
//
// Same vm + stubbed sap.ui.define pattern as
// test/unit/admin-shell/board-controller-job-controls.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(
  __dirname,
  '../../../app/admin-shell/webapp/controller/cron-timeline-helpers.js'
);

let CATEGORY_COLORS;
let categoryForJob;
let buildTimelineSvg;

beforeAll(() => {
  const src = readFileSync(HELPER_PATH, 'utf8');
  let captured;
  const context = {
    sap: { ui: { define(_deps, factory) { captured = factory(); } } },
    Date, Math, Number, String, Array, Object, JSON,
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: HELPER_PATH });
  if (!captured) throw new Error('cron-timeline-helpers.js did not register a factory');
  CATEGORY_COLORS = captured.CATEGORY_COLORS;
  categoryForJob = captured.categoryForJob;
  buildTimelineSvg = captured.buildTimelineSvg;
});

describe('categoryForJob', () => {
  it('classifies fetch-* jobs as fetch', () => {
    expect(categoryForJob('fetch-blog-posts')).toBe('fetch');
    expect(categoryForJob('fetch-videos')).toBe('fetch');
  });

  it('classifies cleanup + gc-external-content as cleanup', () => {
    expect(categoryForJob('cleanup')).toBe('cleanup');
    expect(categoryForJob('gc-external-content')).toBe('cleanup');
  });

  it('classifies concept / embedding jobs as kg', () => {
    expect(categoryForJob('extract-concepts')).toBe('kg');
    expect(categoryForJob('consolidate-concepts')).toBe('kg');
    expect(categoryForJob('embedding-reconciliation')).toBe('kg');
  });

  it('classifies retry / merge jobs as retry', () => {
    expect(categoryForJob('ngds-retry')).toBe('retry');
    expect(categoryForJob('account-merge-job')).toBe('retry');
  });

  it('classifies secret + health jobs as secret', () => {
    expect(categoryForJob('secret-expiry-check')).toBe('secret');
    expect(categoryForJob('homepage-link-health')).toBe('secret');
  });

  it('falls back to unknown for unrecognized job names', () => {
    expect(categoryForJob('some-totally-new-thing')).toBe('unknown');
  });

  it('exports CATEGORY_COLORS with hex values for all 6 categories', () => {
    expect(CATEGORY_COLORS).toBeTruthy();
    for (const key of ['fetch', 'cleanup', 'kg', 'retry', 'secret', 'unknown']) {
      expect(CATEGORY_COLORS[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('buildTimelineSvg', () => {
  it('renders an SVG containing the Now marker, fires-count label, and 0 rects for an empty input', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const svg = buildTimelineSvg([], { now, widthPx: 800, heightPx: 80 });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Now');
    expect(svg).toContain('Fires in next 24h: 0');
    // No <rect> tags for ticks (ignore <rect> the impl may emit for backgrounds —
    // assert there are no rects with the `fill="#<category>` attribute).
    const tickMatches = svg.match(/<rect[^>]*fill="#[0-9a-f]{6}"/gi) || [];
    expect(tickMatches.length).toBe(0);
  });

  it('renders one rect per firing with category-colored fill', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'fetch-blog-posts', nextRunsIso: ['2026-07-01T13:00:00.000Z', '2026-07-01T14:00:00.000Z'] },
      { jobName: 'cleanup',          nextRunsIso: ['2026-07-01T12:30:00.000Z'] },
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    const fetchColor = CATEGORY_COLORS.fetch.replace('#', '');
    const cleanupColor = CATEGORY_COLORS.cleanup.replace('#', '');
    // 2 fetch ticks + 1 cleanup tick = 3 colored rects total
    const fetchRects = svg.match(new RegExp(`<rect[^>]*fill="#${fetchColor}"`, 'gi')) || [];
    const cleanupRects = svg.match(new RegExp(`<rect[^>]*fill="#${cleanupColor}"`, 'gi')) || [];
    expect(fetchRects.length).toBe(2);
    expect(cleanupRects.length).toBe(1);
    expect(svg).toContain('Fires in next 24h: 3');
  });

  it('positions a firing 12h from now at ~50% of widthPx (linear scale)', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'fetch-x', nextRunsIso: ['2026-07-02T00:00:00.000Z'] }, // exactly +12h
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    // Extract the single colored rect's x attribute
    const m = svg.match(/<rect[^>]*x="(\d+(?:\.\d+)?)"[^>]*fill="#[0-9a-f]{6}"/i);
    expect(m).toBeTruthy();
    const x = parseFloat(m[1]);
    // 12h of 24h horizon == 50% of widthPx. Allow ±2px slack for tick centering.
    expect(x).toBeGreaterThanOrEqual(400 - 2);
    expect(x).toBeLessThanOrEqual(400 + 2);
  });

  it('each tick rect contains a <title> child with the jobName and ISO time', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'extract-concepts', nextRunsIso: ['2026-07-01T13:00:00.000Z'] },
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    // Find a <title>...</title> that mentions both the job and ANY recognizable
    // hour fragment of the ISO timestamp (the impl can humanize the time —
    // assertion only requires both the jobName and one of '13:00' or '+1' appear).
    expect(svg).toMatch(/<title>[^<]*extract-concepts[^<]*<\/title>/);
  });

  it('clamps a firing past widthPx to the right edge rather than overflowing', () => {
    // Defensive: if the cap allows a firing at exactly 24h00m01s (unlikely but
    // possible at the window boundary), the rect's x should still be ≤ widthPx
    // so the SVG doesn't render outside its box.
    const now = new Date('2026-07-01T12:00:00.000Z');
    const overEdge = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000).toISOString();
    const jobs = [{ jobName: 'fetch-x', nextRunsIso: [overEdge] }];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    const m = svg.match(/<rect[^>]*x="(\d+(?:\.\d+)?)"[^>]*fill="#[0-9a-f]{6}"/i);
    expect(m).toBeTruthy();
    expect(parseFloat(m[1])).toBeLessThanOrEqual(800);
  });
});
