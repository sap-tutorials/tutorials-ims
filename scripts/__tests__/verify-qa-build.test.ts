import { describe, it, expect } from 'vitest';
import { findForbiddenMarkers, checkQaIndex, checkPrereleaseIndex } from '../verify-qa-build';

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

// ---------------------------------------------------------------------------
// checkPrereleaseIndex — mirrors checkQaIndex tests for prerelease markers
// ---------------------------------------------------------------------------
const PRERELEASE_NAVIGATOR =
  `<div id="tutorial-navigator" data-nav-base="/tutorials-prerelease" data-href-base="/tutorials-prerelease" data-client-search="true"></div>`;
const PRERELEASE_NAVIGATOR_NO_NAV_BASE =
  `<div id="tutorial-navigator" data-client-search="true"></div>`;
const PRERELEASE_NAVIGATOR_NO_CLIENT_SEARCH =
  `<div id="tutorial-navigator" data-nav-base="/tutorials-prerelease" data-href-base="/tutorials-prerelease"></div>`;

const goodPrereleaseHtml = `<html><body>${PRERELEASE_NAVIGATOR}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;

describe('checkPrereleaseIndex', () => {
  it('(a) returns [] for a fully valid prerelease index', () => {
    expect(checkPrereleaseIndex(goodPrereleaseHtml)).toEqual([]);
  });

  it('(b) returns a problem when data-nav-base="/tutorials-prerelease" is missing', () => {
    const html = `<html><body>${PRERELEASE_NAVIGATOR_NO_NAV_BASE}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;
    const problems = checkPrereleaseIndex(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /nav-base/i.test(p))).toBe(true);
  });

  it('(c) returns a problem when data-client-search="true" is missing', () => {
    const html = `<html><body>${PRERELEASE_NAVIGATOR_NO_CLIENT_SEARCH}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;
    const problems = checkPrereleaseIndex(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /client-search/i.test(p))).toBe(true);
  });

  it('(d) does NOT require data-search-base (prerelease uses client-side search)', () => {
    // The key difference from QA: prerelease must NOT have data-search-base as a requirement
    expect(checkPrereleaseIndex(goodPrereleaseHtml)).toEqual([]);
  });

  it('(e) ALLOWS an empty #browse-data all array (prerelease has zero cards until a tutorial is ROLE_GATED, #3168)', () => {
    const html = `<html><body>${PRERELEASE_NAVIGATOR}${BROWSE_SCRIPT_EMPTY}</body></html>`;
    expect(checkPrereleaseIndex(html)).toEqual([]);
  });

  it('(e2) still flags a missing #browse-data script tag (empty is OK, absent is not)', () => {
    const html = `<html><body>${PRERELEASE_NAVIGATOR}</body></html>`;
    const problems = checkPrereleaseIndex(html);
    expect(problems.some(p => /browse-data|grid/i.test(p))).toBe(true);
  });

  it('(e3) still flags a malformed #browse-data with no "all" array', () => {
    const html = `<html><body>${PRERELEASE_NAVIGATOR}<script id="browse-data" type="application/json">{"notAll":1}</script></body></html>`;
    const problems = checkPrereleaseIndex(html);
    expect(problems.some(p => /malformed|all/i.test(p))).toBe(true);
  });

  it('(f) a valid QA index fails checkPrereleaseIndex (different markers)', () => {
    // QA has data-search-base="/qa-search" and data-nav-base="/tutorials-qa"
    // These should fail the prerelease check
    const qaHtml = `<html><body>${NAVIGATOR_WITH_ATTR}${BROWSE_SCRIPT_WITH_DATA}</body></html>`;
    const problems = checkPrereleaseIndex(qaHtml);
    expect(problems.some(p => /tutorials-prerelease/i.test(p))).toBe(true);
  });
});
