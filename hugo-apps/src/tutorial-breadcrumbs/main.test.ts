// @vitest-environment happy-dom
// hugo-apps/src/tutorial-breadcrumbs/main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCacheForTest } from '@shared/group-nav-context';

// Navigator rows mirror /build/navigator tutorialMappings shapes:
// - a mission-path row carries BOTH mission + group fields
// - a standalone-group row carries ONLY group fields (no mission)  ← #1836 case
const navRows = [
  { slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
    groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' },
  { slug: 'cli', groupId: 21221, groupTitle: 'Automating SAP HANA Cloud Tasks',
    groupSlug: 'automating-sap-hana-cloud-tasks', prev: 'scheduling', next: 'pilot' },
];

// Builds the real breadcrumb DOM shape from hugo/layouts/partials/breadcrumbs.html:
// Tutorial Navigator, then optional mission <li>, then optional group <li>, then
// the current-page item. Only roles passed in are baked (mirrors {{ with }}).
function bakeBreadcrumb(opts: { mission?: [string, string]; group?: [string, string] }) {
  const sep = '<li class="fd-breadcrumb__separator" aria-hidden="true"></li>';
  const roleLi = (role: 'mission' | 'group', title: string, slug: string) =>
    `${sep}<li class="fd-breadcrumb__item" data-bc-role="${role}">` +
    `<a class="fd-breadcrumb__link" data-bc-role-link href="/tutorials/${role}-${slug}">${title}</a></li>`;
  const missionLi = opts.mission ? roleLi('mission', opts.mission[0], opts.mission[1]) : '';
  const groupLi = opts.group ? roleLi('group', opts.group[0], opts.group[1]) : '';
  document.body.innerHTML =
    `<nav class="tutorial-breadcrumbs" aria-label="Breadcrumb"><ul class="fd-breadcrumb">` +
    `<li class="fd-breadcrumb__item"><a class="fd-breadcrumb__link" href="/tutorial-navigator/">Tutorial Navigator</a></li>` +
    `${missionLi}${groupLi}${sep}` +
    `<li class="fd-breadcrumb__item fd-breadcrumb__item--current"><button type="button">T</button></li>` +
    `</ul></nav>`;
}

function setPageMeta(slug: string, search: string) {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = slug;
  history.replaceState({}, '', `/tutorials/${slug}${search}`);
}

async function runIsland() { vi.resetModules(); await import('./main'); await new Promise(r => setTimeout(r, 0)); }

function roles() {
  return [...document.querySelectorAll('li[data-bc-role]')].map(li => ({
    role: li.getAttribute('data-bc-role'),
    text: (li.querySelector('a') as HTMLAnchorElement | null)?.textContent,
    href: (li.querySelector('a') as HTMLAnchorElement | null)?.getAttribute('href'),
  }));
}

beforeEach(() => { _resetCacheForTest(); document.body.innerHTML = ''; delete document.documentElement.dataset.pageKind; });
afterEach(() => { vi.restoreAllMocks(); });

describe('tutorial-breadcrumbs context-aware', () => {
  it('with ?from= updates an existing mission+group breadcrumb from the navigator row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/navigator')) return { ok: true, status: 200, json: async () => ({ tutorialMappings: navRows }) };
      throw new Error('should not hit breadcrumb-context when ?from= resolves');
    }));
    bakeBreadcrumb({ mission: ['X', 'x'], group: ['X', 'x'] });
    setPageMeta('t3', '?from=set-up');
    await runIsland();
    expect(roles()).toEqual([
      { role: 'mission', text: 'Jump Start', href: '/tutorials/mission-jump-start' },
      { role: 'group', text: 'Set Up', href: '/tutorials/group-set-up' },
    ]);
  });

  // #1836: baked breadcrumb is a single junk event MISSION; the reader entered
  // from a standalone GROUP. The mission <li> must be removed and a group <li>
  // created — refreshBreadcrumbRole's update-in-place could do neither.
  it('with ?from= on a standalone group replaces a baked mission-only breadcrumb with the group', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/navigator')) return { ok: true, status: 200, json: async () => ({ tutorialMappings: navRows }) };
      throw new Error('should not hit breadcrumb-context when ?from= resolves');
    }));
    bakeBreadcrumb({ mission: ['#A1532C - Devtoberfest 2024', 'a1532c-devtoberfest'] });
    setPageMeta('cli', '?from=automating-sap-hana-cloud-tasks');
    await runIsland();
    expect(roles()).toEqual([
      { role: 'group', text: 'Automating SAP HANA Cloud Tasks', href: '/tutorials/group-automating-sap-hana-cloud-tasks' },
    ]);
    // and the current-page item is still last
    const items = [...document.querySelectorAll('.fd-breadcrumb > li')];
    expect(items[items.length - 1].classList.contains('fd-breadcrumb__item--current')).toBe(true);
  });

  it('with ?from= adds a mission <li> when the row has a mission but baked had group-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/navigator')) return { ok: true, status: 200, json: async () => ({ tutorialMappings: navRows }) };
      throw new Error('unexpected');
    }));
    bakeBreadcrumb({ group: ['Old Group', 'old'] });
    setPageMeta('t3', '?from=set-up');
    await runIsland();
    expect(roles()).toEqual([
      { role: 'mission', text: 'Jump Start', href: '/tutorials/mission-jump-start' },
      { role: 'group', text: 'Set Up', href: '/tutorials/group-set-up' },
    ]);
  });

  it('without ?from= falls back to /build/breadcrumb-context (update-in-place)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/breadcrumb-context'))
        return { ok: true, status: 200, json: async () => ({ missionTitle: 'BC M', missionSlug: 'bc-m', groupTitle: 'BC G', groupSlug: 'bc-g' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    bakeBreadcrumb({ mission: ['X', 'x'], group: ['X', 'x'] });
    setPageMeta('t3', '');
    await runIsland();
    expect((document.querySelector('li[data-bc-role="group"] a') as HTMLAnchorElement).textContent).toBe('BC G');
  });
});
