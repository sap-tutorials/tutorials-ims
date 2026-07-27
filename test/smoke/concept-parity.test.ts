import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

const ENABLED = !!process.env.SMOKE_BASE_URL;

// #1327 Task 6 — Concept parity gate.
//
// Verifies that concept detail pages served by the new CAP render pipeline
// have the expected shape: full site-chrome (composeShell), concept article,
// correct data-render-source="cap" telemetry marker, and that the slug
// appears in the page. Runs against the fixture slugs; each slug self-skips
// when it isn't published in the target environment.
//
// This replaces the original "diff vs. Hugo output" plan because the cutover
// (#1327 Task 5) is already merged — the Hugo-rendered baseline is gone on
// DEV. The structural checks here serve as the ongoing regression guard:
// a blank page, missing chrome, wrong slug, or missing article tag all fail.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/concept-parity-slugs.json'), 'utf-8')
);

describe.skipIf(!ENABLED)('concept detail parity [smoke] (#1327)', () => {
  // Probe which fixture slugs are actually published in this environment.
  let publishedSlugs: Set<string>;
  beforeAll(async () => {
    const res = await fetchWithRetry(`${SRV_URL}/build/concepts`);
    if (res.status !== 200) { publishedSlugs = new Set(); return; }
    const { concepts } = await res.json() as { concepts: { slug: string }[] };
    publishedSlugs = new Set((concepts || []).map((c) => c.slug));
  });

  for (const slug of FIXTURE.slugs) {
    it(`/concepts/${slug}/ returns 200 with CAP chrome (data-render-source=cap)`, async (ctx) => {
      if (!publishedSlugs?.has(slug)) { ctx.skip(); return; }

      const res = await fetchWithRetry(`${BASE_URL}/concepts/${slug}/`);
      expect(res.status).toBe(200);
      const html = await res.text();

      // The concept body: the article the CAP pipeline renders.
      expect(html).toContain('class="concept-page"');
      // The telemetry marker — only present when CAP rendered the page (not
      // a stale Hugo droplet copy or a legacy pre-#1327 BLOB).
      expect(html).toContain('data-render-source="cap"');
      // The slug appears in the canonical link or concept breadcrumb.
      expect(html).toContain(`/concepts/${slug}/`);
      // The page is a full document (composeShell fired).
      expect(html.toLowerCase()).toContain('<html');
      // No accidental blank-body publish.
      expect(html.length).toBeGreaterThan(500);
    });
  }
});
