// test/hugo-css-fingerprint.test.js
//
// Source-string guard for issue #1605: joule.css + sap-fundamental.css must be
// emitted BOTH fingerprinted (edge-safe hashed URL) AND bare (.Publish) so the
// static admin-shell page, scanner, CAP degraded fallback, and smoke tests that
// reference bare /css/<name>.css keep resolving. See the design spec:
// docs/superpowers/specs/2026-08-10-1605-fingerprint-joule-sapfundamental-design.md
//
// Source-string (not rendered-Hugo) for the same reasons as hugo-step-badges.test.js:
// the repo has no Hugo render harness.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

const baseof  = read('hugo/layouts/_default/baseof.html');
const head    = read('hugo/layouts/partials/head.html');
const scanner = read('hugo/layouts/scanner-vue/list.html');

describe('#1605 — joule.css dual-emit (baseof.html)', () => {
  it('fingerprints joule.css', () => {
    expect(baseof).toMatch(/resources\.Get "css\/joule\.css"/);
    expect(baseof).toMatch(/\|\s*fingerprint/);
  });
  it('publishes the bare joule.css copy', () => {
    expect(baseof).toMatch(/\$joule\.Publish/);
  });
  it('no longer links the bare /css/joule.css path', () => {
    expect(baseof).not.toMatch(/href="\/css\/joule\.css"/);
  });
  it('keeps the qa guard', () => {
    expect(baseof).toMatch(/if not site\.Params\.qa/);
  });
});

describe('#1605 — sap-fundamental.css dual-emit (head.html + scanner)', () => {
  it('head.html fingerprints + publishes sap-fundamental.css', () => {
    expect(head).toMatch(/resources\.Get "css\/sap-fundamental\.css"/);
    expect(head).toMatch(/\$fundamental\.Publish/);
    expect(head).toMatch(/\|\s*fingerprint/);
    expect(head).not.toMatch(/href="\/css\/sap-fundamental\.css"/);
  });
  it('scanner layout fingerprints + publishes sap-fundamental.css', () => {
    expect(scanner).toMatch(/resources\.Get "css\/sap-fundamental\.css"/);
    expect(scanner).toMatch(/\$fundamental\.Publish/);
    expect(scanner).toMatch(/\|\s*fingerprint/);
    expect(scanner).not.toMatch(/href="\/css\/sap-fundamental\.css"/);
  });
});

describe('#1605 — source layout / build invariants', () => {
  it('joule.css source lives in assets/, not static/', () => {
    expect(existsSync(join(REPO_ROOT, 'hugo/assets/css/joule.css'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'hugo/static/css/joule.css'))).toBe(false);
  });
  it('the fingerprinted sap-fundamental.css is committed compiled bytes, not the @import source', () => {
    const compiled = read('hugo/assets/css/sap-fundamental.css');
    expect(compiled).not.toMatch(/@import 'fundamental-styles/);
    expect(compiled).toMatch(/step-badge/);
    // the old verbatim static copy must be gone (dual-emit replaces it)
    expect(existsSync(join(REPO_ROOT, 'hugo/static/css/sap-fundamental.css'))).toBe(false);
  });
});
