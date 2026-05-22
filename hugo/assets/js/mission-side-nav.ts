// mission-side-nav.ts — U16

type NavTutorial = { slug: string; title: string; progress: number };
type NavGroup = { title: string; children: NavTutorial[] };
type NavRoot = { children: NavGroup[] };
type NavResponse = { context: NavRoot[] };

const STORAGE_PREFIX = 'mission-nav-expanded:';

function readExpandedState(missionId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + missionId);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeExpandedState(missionId: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + missionId, JSON.stringify(state));
  } catch {
    // quota / private mode — silently fall back to defaults
  }
}

function applyInitialExpansion(nav: HTMLElement, currentSlug: string): void {
  const missionId = nav.dataset.missionId || '';
  const stored = readExpandedState(missionId);
  const items = nav.querySelectorAll<HTMLElement>('ui5-side-navigation-item');
  items.forEach((item) => {
    const groupSlug = item.dataset.groupSlug || '';
    let expanded: boolean;
    if (groupSlug in stored) {
      expanded = stored[groupSlug];
    } else {
      // First visit default: expand only the group containing the current tutorial.
      expanded = !!item.querySelector(`ui5-side-navigation-sub-item[data-tutorial-slug="${CSS.escape(currentSlug)}"]`);
    }
    if (expanded) {
      item.setAttribute('expanded', '');
    } else {
      item.removeAttribute('expanded');
    }
  });
}

function paintProgress(nav: HTMLElement, slug: string, progress: number): void {
  const sub = nav.querySelector<HTMLElement>(`ui5-side-navigation-sub-item[data-tutorial-slug="${CSS.escape(slug)}"]`);
  if (!sub) return;
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  sub.dataset.progress = String(clamped);
  // Per Task 0: sub-items expose no slot — paint via inline CSS custom property
  // consumed by the ::after pseudo defined in mission-side-nav.css.
  sub.style.setProperty('--msn-progress', clamped + '%');
}

function isNavResponse(value: unknown): value is NavResponse {
  if (!value || typeof value !== 'object') return false;
  const ctx = (value as { context?: unknown }).context;
  return Array.isArray(ctx);
}

async function hydrateProgress(nav: HTMLElement): Promise<void> {
  const missionId = nav.dataset.missionId;
  if (!missionId) return;
  try {
    const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/navigation`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (!isNavResponse(body)) return;
    for (const root of body.context) {
      if (!root || !Array.isArray(root.children)) continue;
      for (const group of root.children) {
        if (!group || !Array.isArray(group.children)) continue;
        for (const tut of group.children) {
          if (tut && typeof tut.slug === 'string' && typeof tut.progress === 'number') {
            paintProgress(nav, tut.slug, tut.progress);
          }
        }
      }
    }
  } catch {
    // network / parse error — leave progress at 0%
  }
}

function wireExpandPersistence(nav: HTMLElement): void {
  const missionId = nav.dataset.missionId || '';
  const persist = (): void => {
    const state: Record<string, boolean> = {};
    nav.querySelectorAll<HTMLElement>('ui5-side-navigation-item').forEach((item) => {
      const slug = item.dataset.groupSlug || '';
      if (slug) state[slug] = item.hasAttribute('expanded');
    });
    writeExpandedState(missionId, state);
  };
  // Per Task 0: no dedicated group-toggle event exists in UI5 v2.x.
  // selection-change fires only on selection. Read expanded state via a
  // delegated click + microtask, so we capture the toggle after UI5 applies it.
  nav.addEventListener('click', () => queueMicrotask(persist));
  nav.addEventListener('selection-change', persist);
}

function init(nav: HTMLElement): void {
  const currentSlug = nav.dataset.currentSlug || '';
  applyInitialExpansion(nav, currentSlug);
  wireExpandPersistence(nav);
  void hydrateProgress(nav);
}

const nav = document.querySelector<HTMLElement>('[data-mission-nav]');
if (nav) {
  if (customElements.get('ui5-side-navigation')) {
    init(nav);
  } else {
    void customElements.whenDefined('ui5-side-navigation').then(() => init(nav));
  }
}

export {};
