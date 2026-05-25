// Pinned URL sample for post-deploy a11y + Lighthouse scans.
//
// Paths only — resolved against SMOKE_BASE_URL (approuter) at runtime.
// Keep this list small (~8 URLs). Each URL adds ~10s to the scan job.
//
// Authenticated routes (/admin-ui/, /scanner-ui/) are intentionally
// excluded — unauthenticated scans only see the IDP redirect.
// See docs/historic/aem-gap-analysis.md gap #16 for the auth-scan follow-up.
//
// Update slugs if any of these 404 — pick stable, long-lived ones.
//
// Local-dev caveat: /missions/, /missions/<slug>/, /groups/<slug>/ are
// generated at production build time from /build/catalog (see
// scripts/parsers/cap.ts) — they 404 against `hugo server` locally.
// Don't drop them on that account; they exist on deployed dev/qa/prod.

export const A11Y_URLS = [
  { path: '/',                                        label: 'Home' },
  { path: '/missions/',                               label: 'Missions index (Hugo)' },
  { path: '/missions/abap-dev-get-started/',          label: 'Single mission' },
  { path: '/groups/abap-dev-get-started/',            label: 'Single group / completion path' },
  { path: '/tutorials/abap-cloud-ui-from-interface/', label: 'Tutorial (HANA-served)' },
  { path: '/tutorials/abap-create-basic-app/',        label: 'Tutorial (HANA-served)' },
  { path: '/tags/',                                   label: 'Tag taxonomy index' },
  { path: '/tutorials/',                              label: 'Tutorials list' },
];

export function resolveUrls(baseUrl) {
  const base = (baseUrl || 'http://localhost:1313').replace(/\/$/, '');
  return A11Y_URLS.map(u => ({ ...u, url: `${base}${u.path}` }));
}
