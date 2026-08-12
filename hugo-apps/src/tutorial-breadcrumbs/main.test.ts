// @vitest-environment happy-dom
// hugo-apps/src/tutorial-breadcrumbs/main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCacheForTest } from '@shared/group-nav-context';

const navRows = [{ slug: 't3', missionId: 15069, missionTitle: 'Jump Start', missionSlug: 'jump-start',
  groupId: 15066, groupTitle: 'Set Up', groupSlug: 'set-up', prev: 't2', next: 't4' }];

function setPage(search: string) {
  document.documentElement.dataset.pageKind = 'tutorial';
  document.documentElement.dataset.pageSlug = 't3';
  history.replaceState({}, '', `/tutorials/t3${search}`);
  document.body.innerHTML = `
    <li data-bc-role="mission"><a data-bc-role-link href="/tutorials/mission-x">X</a></li>
    <li data-bc-role="group"><a data-bc-role-link href="/tutorials/group-x">X</a></li>`;
}
async function runIsland() { vi.resetModules(); await import('./main'); await new Promise(r => setTimeout(r, 0)); }

beforeEach(() => { _resetCacheForTest(); document.body.innerHTML = ''; delete document.documentElement.dataset.pageKind; });
afterEach(() => { vi.restoreAllMocks(); });

describe('tutorial-breadcrumbs context-aware', () => {
  it('with ?from= uses the navigator row for that group', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/navigator')) return { ok: true, status: 200, json: async () => ({ tutorialMappings: navRows }) };
      throw new Error('should not hit breadcrumb-context when ?from= resolves');
    }));
    setPage('?from=set-up');
    await runIsland();
    const g = document.querySelector('li[data-bc-role="group"] a') as HTMLAnchorElement;
    expect(g.textContent).toBe('Set Up');
    expect(g.getAttribute('href')).toBe('/tutorials/group-set-up');
    const m = document.querySelector('li[data-bc-role="mission"] a') as HTMLAnchorElement;
    expect(m.getAttribute('href')).toBe('/tutorials/mission-jump-start');
  });

  it('without ?from= falls back to /build/breadcrumb-context', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/build/breadcrumb-context'))
        return { ok: true, status: 200, json: async () => ({ missionTitle: 'BC M', missionSlug: 'bc-m', groupTitle: 'BC G', groupSlug: 'bc-g' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    setPage('');
    await runIsland();
    expect((document.querySelector('li[data-bc-role="group"] a') as HTMLAnchorElement).textContent).toBe('BC G');
  });
});
