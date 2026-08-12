// hugo-apps/src/tutorial-group-nav/main.ts
//
// Rewrites a tutorial page's Next/Prev pills + Next-Steps card to the neighbours
// of the group the reader entered from (?from=<groupSlug>), using /build/navigator.
// Carries ?from= forward so the chain stays in-group. No ?from= / no matching
// row / fetch error → silent no-op (baked links stand).
import { readFromParam, resolveGroupNav } from '@shared/group-nav-context';

function href(slug: string, from: string): string {
  return `/tutorials/${slug}?from=${encodeURIComponent(from)}`;
}

function ensurePill(
  bottom: HTMLElement,
  which: 'prev' | 'next',
  target: string | null,
  from: string,
): void {
  const selector = which === 'next'
    ? 'a.nav-pill--primary'
    : 'a.nav-pill:not(.nav-pill--primary)';
  let a = bottom.querySelector<HTMLAnchorElement>(selector);
  if (!target) { a?.remove(); return; }
  if (!a) {
    a = document.createElement('a');
    a.className = which === 'next' ? 'nav-pill nav-pill--primary' : 'nav-pill';
    a.textContent = which === 'next' ? 'Next →' : '← Previous';
    if (which === 'next') bottom.appendChild(a);
    else bottom.insertBefore(a, bottom.querySelector('.nav-spacer') ?? null); // before spacer (degrades if absent)
  }
  a.setAttribute('href', href(target, from));
}

async function run(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;
  const from = readFromParam(location.search);
  if (!from) return;
  try {
    const row = await resolveGroupNav(slug, from);
    if (!row) return;
    const bottom = document.querySelector<HTMLElement>('.tutorial-nav-bottom');
    if (bottom) {
      ensurePill(bottom, 'prev', row.prev, from);
      ensurePill(bottom, 'next', row.next, from);
    }
    const card = document.querySelector<HTMLAnchorElement>('a.next-steps-card');
    if (card) {
      if (!row.next) card.remove();
      else card.setAttribute('href', href(row.next, from));
    }
  } catch {
    // silent — baked links are the fallback
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void run(); });
} else {
  void run();
}

export {};
