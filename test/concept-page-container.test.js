import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #3095 — source-string guard (same style as test/hugo-css-fingerprint.test.js):
// the repo has no CSS-render harness, so we assert on the CSS SOURCE file.
// NOTE: edits must land in sap-fundamental.src.css (git-tracked source), never
// the gitignored build output sap-fundamental.css.
const src = readFileSync(
  join(import.meta.dirname, '..', 'hugo/assets/css/sap-fundamental.src.css'),
  'utf8',
);

describe('#3095 — concept/topic/channel container base rule', () => {
  it('declares a desktop container rule with 1280px/centered/padded for all four roots', () => {
    // Match the grouped rule that carries max-width (the desktop rule) — the
    // mobile @media block lists the same four selectors but only sets padding,
    // so anchor on a block containing max-width to avoid matching that one.
    const rule = src.match(
      /\.concept-page,\s*\.topic-detail,\s*\.channel-detail,\s*\.channels-page\s*\{[^}]*max-width[^}]*\}/,
    );
    expect(rule, 'grouped desktop base rule present').not.toBeNull();
    expect(rule[0]).toMatch(/max-width:\s*1280px/);
    expect(rule[0]).toMatch(/margin:\s*0 auto/);
    expect(rule[0]).toMatch(/padding:\s*1\.5rem 2rem 3rem/);
  });

  it('adds the four roots to a mobile 1rem padding override', () => {
    for (const r of ['.concept-page', '.topic-detail', '.channel-detail', '.channels-page']) {
      expect(src, `${r} in a 1rem padding rule`).toMatch(
        new RegExp(`${r.replace('.', '\\.')}[\\s\\S]{0,400}padding:\\s*1rem`),
      );
    }
  });

  it('does NOT fold the already-padded index classes into the grouped rule', () => {
    expect(src).not.toMatch(
      /\.concept-page,\s*\.topic-detail,\s*\.channel-detail,\s*\.channels-page,\s*\.concepts-index/,
    );
  });
});
