// test/codeblock-hl-styling.test.js
//
// Source-string guard for issue #3076: legacy `LANG[4, 9, 12]` line-highlight
// fences are rewritten (scripts/parsers/code-highlight-lines.ts) to Hugo's
// `{hl_lines="..."}` attribute, which Chroma renders as `<span class="line hl">`.
// The `.hl` band is styled as a SAP-blue attention band in
// sap-fundamental.src.css. This guard fails if either (a) the band rule is
// dropped from the source, or (b) the compiled sap-fundamental.css was not
// rebuilt from source (`npm run build:css`) — the same load-bearing rebuild
// step guarded by codeblock-err-styling.test.js (#1745).
//
// Source-string (not rendered-Hugo): the repo has no Hugo render harness (same
// rationale as codeblock-err-styling / hugo-css-fingerprint). The end-to-end
// render (legacy fence → compose → Hugo → `<span class="line hl">`) was
// verified against a real Hugo build during development.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

const src = read('hugo/assets/css/sap-fundamental.src.css');
const compiled = read('hugo/assets/css/sap-fundamental.css');

// Matches the light + dark `.hl` band rule bodies regardless of minor whitespace.
// The band is identified by its SAP-blue left accent bar (box-shadow inset).
const lightRule =
  /\.code-block-body\s+\.chroma\s+\.hl\s*\{[^}]*box-shadow:\s*inset[^}]*\}/;
const darkRule =
  /html\.dark\s+\.code-block-body\s+\.chroma\s+\.hl\s*\{[^}]*\}/;

describe('#3076 — code line-highlight .hl band (source)', () => {
  it('styles .hl as an attention band in light theme', () => {
    expect(src).toMatch(lightRule);
  });
  it('styles .hl in dark theme with html.dark specificity', () => {
    expect(src).toMatch(darkRule);
  });
});

describe('#3076 — compiled CSS carries the band (build:css was run)', () => {
  it('light + dark .hl band present in the served stylesheet', () => {
    expect(compiled).toMatch(lightRule);
    expect(compiled).toMatch(darkRule);
  });
});
