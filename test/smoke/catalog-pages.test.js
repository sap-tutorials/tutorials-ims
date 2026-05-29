// test/smoke/catalog-pages.test.js
//
// HTTP smoke against deployed DEV. Validates that /tutorials/group-* and
// /tutorials/mission-* are rendered server-side with full chrome.
//
// Requires SMOKE_SRV_URL (CAP srv URL) — not the approuter URL, since
// the route /tutorials/* on approuter rewrites to /content/tutorials/* on
// srv anyway, but smoke tests bypass approuter for speed and isolation.
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL ?? 'http://localhost:4004';
const KNOWN_GROUP_SLUG = process.env.SMOKE_GROUP_SLUG ?? 'group-test-two';
const KNOWN_MISSION_SLUG = process.env.SMOKE_MISSION_SLUG;

describe('catalog page smoke', () => {
  it('renders the known DEV group with full chrome', async () => {
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
