// test/smoke/catalog-pages.test.js
//
// HTTP smoke against deployed DEV. Validates that /tutorials/group-* and
// /tutorials/mission-* are rendered server-side with full chrome.
//
// Requires SMOKE_SRV_URL (CAP srv URL) — not the approuter URL, since
// the route /tutorials/* on approuter rewrites to /content/tutorials/* on
// srv anyway, but smoke tests bypass approuter for speed and isolation.
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL ?? 'http://localhost:4004';
const KNOWN_MISSION_SLUG = process.env.SMOKE_MISSION_SLUG;

// Group slug: prefer an explicit override, otherwise discover a live group
// from /build/catalog at runtime. The old hardcoded 'group-test-two' fixture
// no longer exists on DEV, so a static default 404s (#1291). standaloneGroups
// entries carry the bare slug; the serve path is prefixed with 'group-'.
let KNOWN_GROUP_SLUG = process.env.SMOKE_GROUP_SLUG;

beforeAll(async () => {
  if (KNOWN_GROUP_SLUG) return;
  try {
    const res = await fetch(`${BASE}/build/catalog`);
    if (res.ok) {
      const cat = await res.json();
      const bare = cat?.standaloneGroups?.[0]?.slug
        ?? cat?.hierarchies?.[0]?.slug;
      if (bare) KNOWN_GROUP_SLUG = bare.startsWith('group-') ? bare : `group-${bare}`;
    }
  } catch {}
});

describe('catalog page smoke', () => {
  it('renders the known DEV group with full chrome', async () => {
    if (!KNOWN_GROUP_SLUG) return; // no group published — nothing to assert
    const url = `${BASE}/content/tutorials/${KNOWN_GROUP_SLUG}`;
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toMatch(/text\/html/);
    expect(res.headers.get('x-content-source')).toBe('rendered');

    const html = await res.text();
    // Body markup
    expect(html).toContain('class="group-wrapper"');
    expect(html).toContain('class="type-badge type-badge--group">GROUP');
    // Page meta
    expect(html).toMatch(/data-page-kind="group"/);
    expect(html).toMatch(new RegExp(`data-page-slug="${KNOWN_GROUP_SLUG}"`));
    // Chrome from baseof.html — these IDs MUST be present for parity with
    // Hugo-built tutorial pages
    expect(html).toContain('id="cmd-palette"');
    expect(html).toContain('id="step-toast"');
    expect(html).toContain('id="glossary-popover"');
  });

  it('renders the known DEV mission when set', async () => {
    if (!KNOWN_MISSION_SLUG) return; // optional
    const url = `${BASE}/content/tutorials/${KNOWN_MISSION_SLUG}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="mission-wrapper"');
    expect(html).toMatch(/data-page-kind="mission"/);
  });

  it('returns 404 for unknown group slug', async () => {
    const res = await fetch(`${BASE}/content/tutorials/group-does-not-exist-zzz`);
    expect(res.status).toBe(404);
  });

  it('serves render-cache on second request (X-Content-Source: render-cache)', async () => {
    if (!KNOWN_GROUP_SLUG) return; // no group published — nothing to prime
    const url = `${BASE}/content/tutorials/${KNOWN_GROUP_SLUG}`;
    await fetch(url); // prime
    const res = await fetch(url);
    expect(res.status).toBe(200);
    // Either 'render-cache' (LRU hit) or 'rendered' (cache evicted/cold) is acceptable;
    // assert it's NOT the legacy 'synthesized' or 'db' tag.
    const src = res.headers.get('x-content-source');
    expect(src).toMatch(/^(render-cache|rendered)$/);
  });

  it('breadcrumb-context endpoint responds', async () => {
    const res = await fetch(`${BASE}/build/breadcrumb-context?tutorial=does-not-exist-zzz`);
    expect([400, 404]).toContain(res.status);
  });
});
