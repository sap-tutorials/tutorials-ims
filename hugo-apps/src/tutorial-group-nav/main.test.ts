// @vitest-environment happy-dom
// hugo-apps/src/tutorial-group-nav/main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCacheForTest } from '@shared/group-nav-context';

const rows = [
  { slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
    groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' },
];

function stubFetch(body: unknown = { tutorialMappings: rows }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

// navBottomHtml is the full inner HTML of .tutorial-nav-bottom — caller is responsible
// for matching production order: [Prev?] <div class="nav-spacer"></div> [Next?].
// extraHtml is appended outside the nav-bottom div (e.g. a.next-steps-card).
function setPage(slug: string, search: string, navBottomHtml: string, extraHtml = '') {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = slug;
  history.replaceState({}, '', `/tutorials/${slug}${search}`);
  document.body.innerHTML = `<div class="tutorial-nav-bottom">${navBottomHtml}</div>${extraHtml}`;
}

async function runIsland() {
  vi.resetModules();
  await import('./main');
  await new Promise((r) => setTimeout(r, 0)); // let the async run() settle
}

beforeEach(() => { _resetCacheForTest(); document.body.innerHTML = ''; delete document.documentElement.dataset.pageKind; });
afterEach(() => { vi.restoreAllMocks(); });

describe('tutorial-group-nav island', () => {
  it('rewrites Next/Prev to the from-group neighbours, carrying ?from= forward', async () => {
    stubFetch();
    // Production order: no baked Prev, spacer, Next
    setPage('t3', '?from=set-up',
      '<div class="nav-spacer"></div><a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    const next = document.querySelector('a.nav-pill--primary') as HTMLAnchorElement;
    expect(next.getAttribute('href')).toBe('/tutorials/t4?from=set-up');
    // Prev pill was absent in HTML but the from-group has a prev → created before the spacer
    const prev = document.querySelector('a.nav-pill:not(.nav-pill--primary)') as HTMLAnchorElement;
    expect(prev.getAttribute('href')).toBe('/tutorials/t2?from=set-up');
    // Verify DOM order: Prev is firstElementChild (inserted before the spacer)
    const bottom = document.querySelector('.tutorial-nav-bottom') as HTMLElement;
    expect(bottom.firstElementChild).toBe(prev);
  });

  it('no ?from= → no-op (baked link untouched)', async () => {
    stubFetch();
    setPage('t3', '',
      '<div class="nav-spacer"></div><a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect((document.querySelector('a.nav-pill--primary') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/adv');
  });

  it('removes the Next pill when the from-group has no next', async () => {
    stubFetch({ tutorialMappings: [{ ...rows[0], slug: 't4', prev: 't3', next: null }] });
    setPage('t4', '?from=set-up',
      '<div class="nav-spacer"></div><a href="/tutorials/x" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect(document.querySelector('a.nav-pill--primary')).toBeNull();
  });

  it('creates a Next pill when the baked HTML has none', async () => {
    stubFetch();
    // Production order: baked Prev only, spacer, no Next
    setPage('t3', '?from=set-up',
      '<a href="/tutorials/bck" class="nav-pill">← Previous</a><div class="nav-spacer"></div>');
    await runIsland();
    const next = document.querySelector('a.nav-pill--primary') as HTMLAnchorElement;
    expect(next).not.toBeNull();
    expect(next.getAttribute('href')).toBe('/tutorials/t4?from=set-up');
  });

  it('removes the Prev pill when the from-group has no prev', async () => {
    stubFetch({ tutorialMappings: [{ ...rows[0], prev: null, next: 't4' }] });
    // Production order: baked Prev, spacer, Next
    setPage('t3', '?from=set-up',
      '<a href="/tutorials/y" class="nav-pill">← Previous</a><div class="nav-spacer"></div>'
      + '<a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect(document.querySelector('a.nav-pill:not(.nav-pill--primary)')).toBeNull();
  });

  it('rewrites the next-steps card when next is present', async () => {
    stubFetch();
    setPage('t3', '?from=set-up',
      '<div class="nav-spacer"></div>',
      '<a href="/tutorials/old" class="next-steps-card">continue</a>');
    await runIsland();
    const card = document.querySelector('a.next-steps-card') as HTMLAnchorElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('href')).toBe('/tutorials/t4?from=set-up');
  });

  it('removes the next-steps card when next is null', async () => {
    stubFetch({ tutorialMappings: [{ ...rows[0], slug: 't4', prev: 't3', next: null }] });
    setPage('t4', '?from=set-up',
      '<div class="nav-spacer"></div>',
      '<a href="/tutorials/old" class="next-steps-card">continue</a>');
    await runIsland();
    expect(document.querySelector('a.next-steps-card')).toBeNull();
  });

  it('carries the neighbour group in ?from= when Next crosses a group boundary (#1775)', async () => {
    // t4 is last in "set-up"; Next crosses into "first-steps" (nextGroupSlug).
    stubFetch({ tutorialMappings: [{
      ...rows[0], slug: 't4', groupSlug: 'set-up', prev: 't3', next: 't5', nextGroupSlug: 'first-steps',
    }] });
    setPage('t4', '?from=set-up',
      '<a href="/tutorials/t3" class="nav-pill">← Previous</a><div class="nav-spacer"></div>'
      + '<a href="/tutorials/x" class="nav-pill nav-pill--primary">Next</a>',
      '<a href="/tutorials/old" class="next-steps-card">continue</a>');
    await runIsland();
    // Next carries the crossed-into group; Prev (in-group) keeps the current from.
    expect((document.querySelector('a.nav-pill--primary') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/t5?from=first-steps');
    expect((document.querySelector('a.nav-pill:not(.nav-pill--primary)') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/t3?from=set-up');
    expect((document.querySelector('a.next-steps-card') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/t5?from=first-steps');
  });

  it('carries the neighbour group in ?from= when Prev crosses a group boundary (#1775)', async () => {
    // t5 is first in "first-steps"; Prev crosses back into "set-up" (prevGroupSlug).
    stubFetch({ tutorialMappings: [{
      ...rows[0], slug: 't5', groupSlug: 'first-steps', prev: 't4', prevGroupSlug: 'set-up', next: 't6',
    }] });
    setPage('t5', '?from=first-steps',
      '<a href="/tutorials/x" class="nav-pill">← Previous</a><div class="nav-spacer"></div>'
      + '<a href="/tutorials/y" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect((document.querySelector('a.nav-pill:not(.nav-pill--primary)') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/t4?from=set-up');
    // Next stays in-group → keeps the current from.
    expect((document.querySelector('a.nav-pill--primary') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/t6?from=first-steps');
  });
});
