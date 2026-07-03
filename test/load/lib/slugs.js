// test/load/lib/slugs.js
// One-shot slug fetch used in each scenario's setup() function. k6 runs
// setup() ONCE before VUs start; its return value is passed to the
// default export and shared across VUs (immutable in workers).

import http from 'k6/http';

export default function fetchSlugs(srvUrl) {
  const res = http.get(`${srvUrl}/build/catalog`, {
    tags: { endpoint: 'setup-catalog' },
    timeout: '30s',
  });
  if (res.status !== 200) {
    throw new Error(
      `setup: /build/catalog returned ${res.status} — cannot resolve slugs`,
    );
  }
  const body = res.json();
  const tutorialSlugs = [];
  // Catalog shape: { missions: [ { tutorials: [ { slug } ] } ] }
  // Defensive: unknown extras are OK, missing arrays are fatal.
  for (const mission of body.missions || []) {
    for (const t of mission.tutorials || []) {
      if (t && typeof t.slug === 'string' && t.slug.length > 0) {
        tutorialSlugs.push(t.slug);
      }
    }
  }
  if (tutorialSlugs.length === 0) {
    throw new Error(
      'setup: /build/catalog returned zero tutorial slugs — env misconfigured?',
    );
  }

  // Advocates list — separate endpoint, one lookup.
  const advRes = http.get(`${srvUrl}/api/advocates`, {
    tags: { endpoint: 'setup-advocates' },
    timeout: '30s',
  });
  const advocateSlugs = [];
  if (advRes.status === 200) {
    const advBody = advRes.json();
    for (const a of advBody.advocates || advBody || []) {
      if (a && typeof a.slug === 'string' && a.slug.length > 0) {
        advocateSlugs.push(a.slug);
      }
    }
  }
  // Advocates being empty is a warning, not fatal — the /api/advocates/:slug/photo
  // scenario step will simply skip if no slugs are available.
  return { tutorialSlugs, advocateSlugs };
}
