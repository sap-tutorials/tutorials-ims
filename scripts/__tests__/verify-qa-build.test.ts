import { describe, it, expect } from 'vitest';
import { findForbiddenMarkers, checkQaIndex } from '../verify-qa-build';

describe('verify-qa-build', () => {
  it('flags forbidden markers in QA output', () => {
    const r = findForbiddenMarkers('<button id="op-mark-complete">x</button>');
    expect(r).toContain('op-mark-complete');
  });
  it('returns empty for clean output', () => {
    expect(findForbiddenMarkers('<p>hello</p>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkQaIndex — four cases
// ---------------------------------------------------------------------------
const BROWSE_SCRIPT_WITH_DATA =
  `<script id="browse-data" type="application/json">{"all":[{"slug":"cap-getting-started","title":"Get started with CAP"}]}</script>`;
const BROWSE_SCRIPT_EMPTY =
  `<script id="browse-data" type="application/json">{"all":[]}</script>`;
const NAVIGATOR_WITH_ATTR =
  `<div id="tutorial-navigator" data-search-base="/qa-search" data-foo="bar"></div>`;
const NAVIGATOR_WITHOUT_ATTR =
  `<div id="tutorial-navigator" data-foo="bar"></div>`;

const goodHtml = `<html><body>${NAVIGATOR_WITH_ATTR}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;

describe('checkQaIndex', () => {
  it('(a) returns [] for a fully valid QA index', () => {
    expect(checkQaIndex(goodHtml)).toEqual([]);
  });

  it('(b) returns a problem when data-search-base="/qa-search" is missing', () => {
    const html = `<html><body>${NAVIGATOR_WITHOUT_ATTR}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;
    const problems = checkQaIndex(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /search-base/i.test(p))).toBe(true);
  });

  it('(c) returns a problem when #browse-data all array is empty', () => {
    const html = `<html><body>${NAVIGATOR_WITH_ATTR}${BROWSE_SCRIPT_EMPTY}</body></html>`;
    const problems = checkQaIndex(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /grid|browse/i.test(p))).toBe(true);
  });

  it('(d) returns a problem when #browse-data script tag is absent', () => {
    const html = `<html><body>${NAVIGATOR_WITH_ATTR}</body></html>`;
    const problems = checkQaIndex(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /grid|browse/i.test(p))).toBe(true);
  });
});
