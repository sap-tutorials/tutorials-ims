// hugo-apps/src/tutorial-breadcrumbs/main.ts
//
// Refreshes parent group + mission text in tutorial-page breadcrumbs.
//
// When ?from=<groupSlug> is present the navigator mapping is used and the parent
// crumbs are fully RESHAPED to the entry container (create/remove/update the
// mission and group <li>s). This matters because the baked breadcrumb reflects
// the tutorial's canonical owner, which can differ in SHAPE from the clicked
// entry — e.g. a tutorial baked under a single-tutorial event mission that the
// reader opened from a standalone group has a baked mission <li> but needs a
// group <li> instead (#1836). Simple text-only updates couldn't switch shapes.
//
// Without ?from= we fall back to /build/breadcrumb-context and only refresh the
// TEXT/href of whatever parent crumbs the last build baked (rename refresh).
//
// Failure mode: silent no-op. The static text from the last build remains —
// worst case is stale parent text, never a broken page.

import { readFromParam, resolveGroupNav } from '@shared/group-nav-context';

interface BreadcrumbContext {
  missionTitle: string | null;
  missionSlug: string | null;
  groupTitle: string | null;
  groupSlug: string | null;
}

function refreshBreadcrumbRole(role: 'mission' | 'group', title: string | null, slug: string | null): void {
  if (!title || !slug) return;
  const li = document.querySelector(`li[data-bc-role="${role}"]`);
  if (!li) return;
  const link = li.querySelector('a[data-bc-role-link]') as HTMLAnchorElement | null;
  if (!link) return;
  const wantedHref = `/tutorials/${role}-${slug}`;
  if (link.textContent !== title) {
    link.textContent = title;
  }
  if (link.getAttribute('href') !== wantedHref) {
    link.setAttribute('href', wantedHref);
  }
}

// Builds a separator + parent-crumb <li> pair for the given role.
function makeCrumb(role: 'mission' | 'group', title: string, slug: string): [HTMLLIElement, HTMLLIElement] {
  const sep = document.createElement('li');
  sep.className = 'fd-breadcrumb__separator';
  sep.setAttribute('aria-hidden', 'true');
  const li = document.createElement('li');
  li.className = 'fd-breadcrumb__item';
  li.setAttribute('data-bc-role', role);
  const a = document.createElement('a');
  a.className = 'fd-breadcrumb__link';
  a.setAttribute('data-bc-role-link', '');
  a.setAttribute('href', `/tutorials/${role}-${slug}`);
  a.textContent = title;
  li.appendChild(a);
  return [sep, li];
}

// Fully reshapes the mission + group parent crumbs to `ctx`: removes the existing
// parent crumbs (and their leading separators), then rebuilds mission-then-group
// (only those present in `ctx`) immediately before the current-page item. This
// switches a mission-shaped breadcrumb to a group-shaped one and vice versa.
// Returns false (so the caller can fall back to update-in-place) if the expected
// structure isn't found.
function reshapeParentCrumbs(ctx: BreadcrumbContext): boolean {
  const ul = document.querySelector('nav.tutorial-breadcrumbs ul.fd-breadcrumb') as HTMLElement | null;
  if (!ul) return false;
  const current = ul.querySelector('.fd-breadcrumb__item--current');
  if (!current) return false;

  for (const li of Array.from(ul.querySelectorAll('li[data-bc-role]'))) {
    const prev = li.previousElementSibling;
    if (prev && prev.classList.contains('fd-breadcrumb__separator')) prev.remove();
    li.remove();
  }

  const insert = (role: 'mission' | 'group', title: string | null | undefined, slug: string | null | undefined) => {
    if (!title || !slug) return;
    const [sep, li] = makeCrumb(role, title, slug);
    ul.insertBefore(sep, current);
    ul.insertBefore(li, current);
  };
  insert('mission', ctx.missionTitle, ctx.missionSlug);
  insert('group', ctx.groupTitle, ctx.groupSlug);
  return true;
}

async function refreshBreadcrumbs(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;

  const from = readFromParam(location.search);
  if (from) {
    try {
      const row = await resolveGroupNav(slug, from);
      if (row) {
        const ctx: BreadcrumbContext = {
          missionTitle: row.missionTitle ?? null,
          missionSlug: row.missionSlug ?? null,
          groupTitle: row.groupTitle ?? null,
          groupSlug: row.groupSlug ?? null,
        };
        // Reshape to the entry container; if the DOM shape is unexpected, degrade
        // to text-only updates so a rename still refreshes.
        if (!reshapeParentCrumbs(ctx)) {
          refreshBreadcrumbRole('mission', ctx.missionTitle, ctx.missionSlug);
          refreshBreadcrumbRole('group', ctx.groupTitle, ctx.groupSlug);
        }
        return;
      }
    } catch {
      // fall through to breadcrumb-context
    }
  }

  try {
    const res = await fetch(`/build/breadcrumb-context?tutorial=${encodeURIComponent(slug)}`, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    const ctx: BreadcrumbContext = await res.json();
    refreshBreadcrumbRole('mission', ctx.missionTitle, ctx.missionSlug);
    refreshBreadcrumbRole('group', ctx.groupTitle, ctx.groupSlug);
  } catch {
    // Silent — static breadcrumb text is the fallback.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void refreshBreadcrumbs(); });
} else {
  void refreshBreadcrumbs();
}
