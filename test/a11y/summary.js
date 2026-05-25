#!/usr/bin/env node
// Combine axe-core + Lighthouse CI output into a single markdown summary.
// Designed to be piped into $GITHUB_STEP_SUMMARY by the deploy workflow:
//
//   node test/a11y/summary.js >> "$GITHUB_STEP_SUMMARY"
//
// Reads:
//   - test/a11y/axe-results.md      (written by axe.test.js)
//   - .lighthouseci/lhr-*.json      (written by `lhci collect`)
//   - .lighthouseci/links.json      (written by `lhci upload` to temp storage)
//
// All inputs are optional — missing files are reported but don't fail.
// We read the lhr-*.json files directly rather than manifest.json because
// manifest.json is only written under certain upload modes; lhr files are
// always written by `collect`.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const AXE_PATH = join(cwd, 'test/a11y/axe-results.md');
const LHCI_DIR = join(cwd, '.lighthouseci');
const LINKS    = join(LHCI_DIR, 'links.json');

const out = [];
out.push('## Accessibility & Performance scan');
out.push('');
out.push('_Warn-only mode — failures here do not block deploy. See `docs/historic/aem-gap-analysis.md` gap #16._');
out.push('');

// --- Lighthouse section ----------------------------------------------------
const lhrFiles = existsSync(LHCI_DIR)
  ? readdirSync(LHCI_DIR).filter(f => f.startsWith('lhr-') && f.endsWith('.json'))
  : [];

if (lhrFiles.length > 0) {
  const links = existsSync(LINKS) ? JSON.parse(readFileSync(LINKS, 'utf8')) : {};

  out.push('### Lighthouse');
  out.push('');
  out.push('| Page | Perf | A11y | Best Pract. | SEO | Report |');
  out.push('|------|------|------|-------------|-----|--------|');

  const seen = new Set();
  for (const file of lhrFiles) {
    const lhr = JSON.parse(readFileSync(join(LHCI_DIR, file), 'utf8'));
    const finalUrl = lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl;
    if (!finalUrl || seen.has(finalUrl)) continue;
    seen.add(finalUrl);

    const cats = lhr.categories || {};
    const fmt = (k) => cats[k]?.score != null ? Math.round(cats[k].score * 100) : '—';
    const path = finalUrl.replace(/^https?:\/\/[^/]+/, '') || '/';
    const link = links[finalUrl] || links[lhr.requestedUrl] ? `[report](${links[finalUrl] || links[lhr.requestedUrl]})` : '—';

    out.push(`| ${path} | ${fmt('performance')} | ${fmt('accessibility')} | ${fmt('best-practices')} | ${fmt('seo')} | ${link} |`);
  }
  out.push('');
} else {
  out.push('### Lighthouse');
  out.push('');
  out.push('_No Lighthouse reports found in `.lighthouseci/` — `lhci collect` may have failed._');
  out.push('');
}

// --- axe-core section ------------------------------------------------------
if (existsSync(AXE_PATH)) {
  const axe = readFileSync(AXE_PATH, 'utf8');
  out.push(axe.replace(/^# axe-core a11y scan\s*/, '### axe-core\n\n'));
} else {
  out.push('### axe-core');
  out.push('');
  out.push('_No axe results found at `test/a11y/axe-results.md` — the Vitest a11y project may have been skipped (no `SMOKE_BASE_URL`)._ ');
}

process.stdout.write(out.join('\n') + '\n');
