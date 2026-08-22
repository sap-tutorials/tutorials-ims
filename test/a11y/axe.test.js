// Post-deploy axe-core a11y regression gate.
//
// Walks each URL in test/a11y/urls.js with Playwright + @axe-core/playwright,
// compares the result against the committed baseline (test/a11y/baseline.json),
// and FAILS the test (→ the deploy.yml `a11y-scan` job goes red) when a page
// regresses. A page regresses when a NEW axe rule id appears, or its
// critical / serious violation count rises above baseline. Moderate/minor
// churn on already-known rules is reported but never fails — it keeps the gate
// from flapping on cosmetic DOM shifts (region/landmark node counts, etc.).
//
// A markdown summary is written to test/a11y/axe-results.md AFTER EACH PAGE
// (not only in afterAll) so a slow browser teardown can't drop the data — the
// previous version wrote only in afterAll and lost every result when the hook
// timed out.
//
// Update the baseline after intentionally fixing/changing a page:
//   A11Y_UPDATE_BASELINE=1 SMOKE_BASE_URL=<dev-approuter> npm run test:a11y
// This rewrites baseline.json (ratchet DOWN; never raise without review) and
// skips the gate for that run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUrls } from './urls.js';

const BASE_URL = process.env.SMOKE_BASE_URL || process.env.A11Y_BASE_URL;
const UPDATE_BASELINE = process.env.A11Y_UPDATE_BASELINE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(HERE, 'axe-results.md');
const BASELINE_FILE = join(HERE, 'baseline.json');

// WCAG 2.1 AA + best-practice — matches what Siteimprove flags.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// Persistent WebSocket (/ws/event-stream) + analytics beacons mean these pages
// NEVER reach 'networkidle'. Wait for 'load' + a short settle instead, or every
// goto times out and the scan collects errors rather than data.
const SETTLE_MS = 2500;

const baseline = loadBaseline();

describe.skipIf(!BASE_URL)('axe-core a11y regression gate', () => {
  let browser;
  const results = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    writeMarkdown(results);
    if (UPDATE_BASELINE) writeBaseline(results);
  });

  for (const target of resolveUrls(BASE_URL)) {
    it(`scans ${target.label} (${target.path})`, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const scanResult = { url: target.url, label: target.label, path: target.path };

      try {
        const response = await page.goto(target.url, { waitUntil: 'load', timeout: 30000 });
        scanResult.status = response?.status() ?? 0;

        if (!response || !response.ok()) {
          scanResult.error = `HTTP ${scanResult.status}`;
        } else {
          await page.waitForTimeout(SETTLE_MS);
          const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          scanResult.violations = axe.violations;
          scanResult.passes = axe.passes.length;
        }
      } catch (err) {
        scanResult.error = err.message;
      } finally {
        await context.close();
        results.push(scanResult);
        // Write after every page so a slow teardown can't lose the summary.
        writeMarkdown(results);
      }

      if (scanResult.error) {
        // A scan that couldn't run is a scan failure, not an a11y pass. Fail so
        // a broken/404 page or timeout is visible rather than silently green.
        throw new Error(`Could not scan ${target.path}: ${scanResult.error}`);
      }

      if (UPDATE_BASELINE) return; // capture-only run, no gating

      const regressions = diffAgainstBaseline(scanResult);
      expect(regressions, formatRegressions(target, regressions)).toEqual([]);
    }, 60000);
  }
});

// --- baseline helpers ------------------------------------------------------

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return { pages: {} };
  }
}

function pageBaseline(path) {
  return (baseline.pages && baseline.pages[path]) || { critical: 0, serious: 0, rules: [] };
}

function summarize(scanResult) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const rules = new Set();
  for (const v of scanResult.violations || []) {
    counts[v.impact] = (counts[v.impact] || 0) + 1;
    rules.add(v.id);
  }
  return { counts, rules: [...rules].sort() };
}

function diffAgainstBaseline(scanResult) {
  const base = pageBaseline(scanResult.path);
  const { counts, rules } = summarize(scanResult);
  const regressions = [];

  const known = new Set(base.rules || []);
  for (const id of rules) {
    if (!known.has(id)) regressions.push(`new rule: ${id}`);
  }
  if (counts.critical > (base.critical || 0)) {
    regressions.push(`critical ${base.critical || 0} → ${counts.critical}`);
  }
  if (counts.serious > (base.serious || 0)) {
    regressions.push(`serious ${base.serious || 0} → ${counts.serious}`);
  }
  return regressions;
}

function formatRegressions(target, regressions) {
  if (regressions.length === 0) return '';
  return [
    `a11y regression on ${target.path} (${target.label}):`,
    ...regressions.map(r => `  - ${r}`),
    `If intentional, refresh the baseline: A11Y_UPDATE_BASELINE=1 npm run test:a11y`,
  ].join('\n');
}

function writeBaseline(results) {
  const pages = {};
  for (const r of results) {
    if (r.error) continue; // don't bake an error page into the baseline
    const { counts, rules } = summarize(r);
    pages[r.path] = { critical: counts.critical, serious: counts.serious, rules };
  }
  const next = {
    _comment: baseline._comment,
    _howItGates: baseline._howItGates,
    _howToUpdate: baseline._howToUpdate,
    _capturedAgainst: 'dev approuter, WCAG 2.1 AA + best-practice tags',
    _capturedOn: baseline._capturedOn,
    pages,
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`baseline updated: ${BASELINE_FILE}`);
}

// --- markdown summary ------------------------------------------------------

function writeMarkdown(results) {
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

  const lines = ['# axe-core a11y scan', ''];
  if (BASE_URL) lines.push(`**Base URL:** ${BASE_URL}`, '');
  if (UPDATE_BASELINE) lines.push('_Baseline-update run — gating skipped._', '');

  let totalViolations = 0;
  let totalCritical = 0;

  lines.push('| Page | HTTP | Violations | Critical | Serious | Mod. | Minor | Regressed |');
  lines.push('|------|------|------------|----------|---------|------|-------|-----------|');

  for (const r of results) {
    if (r.error && !r.violations) {
      lines.push(`| ${r.label} (${r.path}) | ${r.status ?? '—'} | error: ${r.error} | | | | | ⚠️ |`);
      continue;
    }
    const { counts } = summarize(r);
    totalViolations += (r.violations || []).length;
    totalCritical += counts.critical;
    const regressed = UPDATE_BASELINE ? '—' : (diffAgainstBaseline(r).length ? '❌' : '✅');
    lines.push(`| ${r.label} (${r.path}) | ${r.status} | ${(r.violations || []).length} | ${counts.critical} | ${counts.serious} | ${counts.moderate} | ${counts.minor} | ${regressed} |`);
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
}
