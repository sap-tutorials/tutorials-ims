// hugo-apps/src/tutorial-breadcrumbs/main.ts
//
// Refreshes parent group + mission text in tutorial-page breadcrumbs after a
// Group/Mission rename. The static HTML carries last-build values; this fetch
// pulls the current state from /build/breadcrumb-context and overwrites the
// <li> text + href if it has changed.
//
// Failure mode: silent no-op. The static text from the last build remains —
// worst case is stale parent text, never a broken page.

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

async function refreshBreadcrumbs(): Promise<void> {
  const html = document.documentElement;
  if (html.dataset.pageKind !== 'tutorial') return;
  const slug = html.dataset.pageSlug;
  if (!slug) return;

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
