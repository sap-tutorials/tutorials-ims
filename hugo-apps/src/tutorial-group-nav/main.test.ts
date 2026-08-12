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

function setPage(slug: string, search: string, navBottomHtml: string) {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = slug;
  history.replaceState({}, '', `/tutorials/${slug}${search}`);
  document.body.innerHTML = `<div class="tutorial-nav-bottom">${navBottomHtml}<div class="nav-spacer"></div></div>`;
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
    setPage('t3', '?from=set-up',
      '<a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    const next = document.querySelector('a.nav-pill--primary') as HTMLAnchorElement;
    expect(next.getAttribute('href')).toBe('/tutorials/t4?from=set-up');
    // Prev pill was absent in HTML but the from-group has a prev → created
    const prev = document.querySelector('a.nav-pill:not(.nav-pill--primary)') as HTMLAnchorElement;
    expect(prev.getAttribute('href')).toBe('/tutorials/t2?from=set-up');
  });

  it('no ?from= → no-op (baked link untouched)', async () => {
    stubFetch();
    setPage('t3', '',
      '<a href="/tutorials/adv" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect((document.querySelector('a.nav-pill--primary') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/tutorials/adv');
  });

  it('removes the Next pill when the from-group has no next', async () => {
    stubFetch({ tutorialMappings: [{ ...rows[0], slug: 't4', prev: 't3', next: null }] });
    setPage('t4', '?from=set-up',
      '<a href="/tutorials/x" class="nav-pill nav-pill--primary">Next</a>');
    await runIsland();
    expect(document.querySelector('a.nav-pill--primary')).toBeNull();
  });
});
