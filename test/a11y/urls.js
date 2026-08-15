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
// Prefer STABLE, always-present routes over per-slug catalog pages: the old
// list pinned /missions/, /missions/<slug>/, /groups/<slug>/, /tutorials/ which
// (a) rot when a specific mission/group slug is retired and (b) don't serve a
// 200 anyway on deployed envs — the approuter routes /tutorials/* and the
// mission/group index paths to CAP, which 404s the bare index (and PROD
// 301-redirects them). Verified 2026-08-15: all paths below return 200 on DEV
// (and are the stable, CAP-served content routes present across dev/qa/prod).

export const A11Y_URLS = [
  { path: '/',                                        label: 'Home' },
  { path: '/browse/',                                 label: 'Browse catalog (CAP-served)' },
  { path: '/topics/',                                 label: 'Topics gallery (CAP-served)' },
  { path: '/concepts/cap-cds-domain-modeling/',       label: 'Concept page (CAP-served)' },
  { path: '/tutorials/abap-cloud-ui-from-interface/', label: 'Tutorial (HANA-served)' },
  { path: '/tutorials/abap-create-basic-app/',        label: 'Tutorial (HANA-served)' },
  { path: '/tags/',                                   label: 'Tag taxonomy index' },
  { path: '/developer-advocates/',                    label: 'Developer Advocates' },
];

export function resolveUrls(baseUrl) {
  const base = (baseUrl || 'http://localhost:1313').replace(/\/$/, '');
  return A11Y_URLS.map(u => ({ ...u, url: `${base}${u.path}` }));
}
