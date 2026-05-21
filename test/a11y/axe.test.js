// Post-deploy axe-core a11y scan (warn-only).
//
// Walks each URL in test/a11y/urls.js with Playwright + @axe-core/playwright,
// writes a markdown summary to test/a11y/axe-results.md, and ALWAYS passes
// the Vitest assertion. Scoring/gating is intentionally deferred — the goal
// of the first iteration is baseline data, not a release block.
//
// To turn this into a hard gate later, change the `expect(0)` line to
// assert violation counts directly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUrls } from './urls.js';

const BASE_URL = process.env.SMOKE_BASE_URL || process.env.A11Y_BASE_URL;
const OUTPUT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'axe-results.md');

// WCAG 2.1 AA + best-practice — matches what Siteimprove flags.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

describe.skipIf(!BASE_URL)('axe-core a11y scan', () => {
  let browser;
  const results = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    writeMarkdown(results);
  });

  for (const target of resolveUrls(BASE_URL)) {
    it(`scans ${target.label} (${target.path})`, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      let scanResult = { url: target.url, label: target.label, path: target.path };

      try {
        const response = await page.goto(target.url, { waitUntil: 'networkidle', timeout: 25000 });
        scanResult.status = response?.status() ?? 0;

        if (!response || !response.ok()) {
          scanResult.error = `HTTP ${scanResult.status}`;
        } else {
          const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          scanResult.violations = axe.violations;
          scanResult.passes = axe.passes.length;
        }
      } catch (err) {
        scanResult.error = err.message;
      } finally {
        await context.close();
        results.push(scanResult);
      }

      // Warn-only: never fail the test on a11y violations or HTTP errors.
      expect(true).toBe(true);
    }, 45000);
  }
});

function writeMarkdown(results) {
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

  const lines = ['# axe-core a11y scan', ''];
  if (BASE_URL) lines.push(`**Base URL:** ${BASE_URL}`, '');

  let totalViolations = 0;
  let totalCritical = 0;

  lines.push('| Page | HTTP | Violations | Critical | Serious | Mod. | Minor |');
  lines.push('|------|------|------------|----------|---------|------|-------|');

  for (const r of results) {
    if (r.error && !r.violations) {
      lines.push(`| ${r.label} (${r.path}) | ${r.status ?? '—'} | error: ${r.error} | | | | |`);
      continue;
    }
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of r.violations || []) counts[v.impact] = (counts[v.impact] || 0) + 1;
    totalViolations += (r.violations || []).length;
    totalCritical += counts.critical;
    lines.push(`| ${r.label} (${r.path}) | ${r.status} | ${(r.violations || []).length} | ${counts.critical} | ${counts.serious} | ${counts.moderate} | ${counts.minor} |`);
  }

  lines.push('', `**Total violations:** ${totalViolations} (${totalCritical} critical)`, '');

  const withDetail = results.filter(r => (r.violations || []).length > 0);
  if (withDetail.length > 0) {
    lines.push('## Top violations', '');
    for (const r of withDetail) {
      lines.push(`### ${r.label}`);
      for (const v of r.violations.slice(0, 5)) {
        lines.push(`- **${v.id}** (${v.impact}, ${v.nodes.length} nodes) — ${v.help}`);
        if (v.helpUrl) lines.push(`  - ${v.helpUrl}`);
      }
      lines.push('');
    }
  }

  writeFileSync(OUTPUT_FILE, lines.join('\n'));
  console.log(`axe results written to ${OUTPUT_FILE}`);
}
