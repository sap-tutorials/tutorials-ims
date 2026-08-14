// test/codeblock-err-styling.test.js
//
// Source-string guard for issue #1745: Chroma marks any token its lexer cannot
// parse with `.err`, which the generated chroma-light.css paints white-on-dark-
// red (#82071e) and chroma-dark.css paints bright red (#f85149). On tutorial
// content this misfires on valid-but-unlexable syntax — VS Code REST Client
// (.http) blocks tagged ```HTTP had EVERY line flagged (so the whole block
// rendered as a solid red blob), and hdbsql interactive commands (\al, \s, \q…)
// inside ```SQL/```HDBSQL showed as ugly red backslashes.
//
// The fix is a high-specificity override in sap-fundamental.src.css that
// repaints `.err` to the normal code foreground with a transparent background
// in both themes. This guard fails if either (a) the override is dropped from
// the source, or (b) the compiled sap-fundamental.css was not rebuilt from the
// source (npm run build:css) — the load-bearing step that a merged-but-not-
// rebuilt CSS change would otherwise silently skip.
//
// Source-string (not rendered-Hugo): the repo has no Hugo render harness, same
// rationale as hugo-css-fingerprint.test.js / hugo-step-badges.test.js. The
// end-to-end computed-style behaviour was verified with a headless browser
// during development (both themes: normal fg on transparent bg).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

const src = read('hugo/assets/css/sap-fundamental.src.css');
const compiled = read('hugo/assets/css/sap-fundamental.css');

// Matches the light + dark override rule bodies regardless of minor whitespace.
const lightRule =
  /\.code-block-body\s+\.chroma\s+\.err\s*\{[^}]*color:\s*inherit[^}]*background-color:\s*transparent[^}]*\}/;
const darkRule =
  /html\.dark\s+\.code-block-body\s+\.chroma\s+\.err\s*\{[^}]*color:\s*inherit[^}]*background-color:\s*transparent[^}]*\}/;

describe('#1745 — Chroma .err token neutralization (source)', () => {
  it('neutralizes .err in light theme (normal fg, transparent bg)', () => {
    expect(src).toMatch(lightRule);
  });
  it('neutralizes .err in dark theme with html.dark specificity', () => {
    expect(src).toMatch(darkRule);
  });
});

describe('#1745 — compiled CSS carries the override (build:css was run)', () => {
  it('light + dark .err overrides present in the served stylesheet', () => {
    expect(compiled).toMatch(lightRule);
    expect(compiled).toMatch(darkRule);
  });
});
