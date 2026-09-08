import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

let tutorialPath = '/tutorials/abap-cloud-ui-from-interface/';

beforeAll(async () => {
  try {
    const res = await fetchWithRetry(`${BASE_URL}/llms.txt`);
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/\((https?:\/\/developers\.sap\.com\/tutorials\/[^)]+)\)/);
      if (m) {
        const u = new URL(m[1]);
        tutorialPath = u.pathname;
      }
    }
  } catch {}
});

describe('Meta tags — homepage', () => {
  let html;
  it('fetches', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    html = await res.text();
  });

  it('has correct title (no duplication)', () => {
    // Brand is "SAP Developer Center" (hugo.toml title/brand). head-meta.html
    // emits the bare brand on the homepage (cond .IsHome $brand ...).
    expect(html).toMatch(/<title>SAP Developer Center<\/title>/);
  });

  it('has canonical, description, robots, content-signal', () => {
    expect(html).toMatch(/<link rel=["']?canonical["']? href=["']?https:\/\/developers\.sap\.com\/["']?/);
    expect(html).toMatch(/<meta name=["']?description["']? content="[^"]+"/);
    expect(html).toMatch(/<meta name=["']?robots["']? content="[^"]*max-image-preview:large[^"]*"/);
    expect(html).toMatch(/<meta name=["']?content-signal["']? content="index=yes, ai-train=no, ai-search=yes"/);
  });

  it('has Open Graph + Twitter Card', () => {
    expect(html).toMatch(/<meta property=["']?og:site_name["']? content="SAP Developer Center"/);
    expect(html).toMatch(/<meta property=["']?og:url["']? content="https:\/\/developers\.sap\.com\/"/);
    expect(html).toMatch(/<meta name=["']?twitter:card["']? content="summary_large_image"/);
    expect(html).toMatch(/<meta name=["']?twitter:site["']? content="@sapdevs"/);
  });
});

describe('Meta tags — tutorial page', () => {
  let html;
  it('fetches', async () => {
    const res = await fetchWithRetry(`${BASE_URL}${tutorialPath}`);
    expect(res.status).toBe(200);
    html = await res.text();
  });

  it('has " | SAP Developer Center" suffix in title', () => {
    // head-meta.html: content pages emit "<Title> | <brand>" where brand is
    // "SAP Developer Center" (hugo.toml).
    expect(html).toMatch(/<title>[^<]+ \| SAP Developer Center<\/title>/);
  });

  it('has og:type=article and article metadata', () => {
    expect(html).toMatch(/<meta property=["']?og:type["']? content="article"/);
  });

  it('has author meta tag', () => {
    expect(html).toMatch(/<meta name=["']?author["']? content="[^"]+"/);
  });

  it('has sm_tech_ids meta tag when tutorial has product tags', () => {
    // head-meta.html emits sm_tech_ids only when .Params.smTechIds is present.
    // Expected format: en-US,<id>,<id>,...
    expect(html).toMatch(/<meta name=["']?sm_tech_ids["']? content="en-US,[^"]*"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sm_tech_ids — mission page
//
// Hard-gated on SMOKE_MISSION_SLUG env var. Self-skips when the var is unset
// so CI stays green while no confirmed slug has been provided, but FAILS (not
// skips) when the slug IS supplied and the page is missing sm_tech_ids.
//
// Set SMOKE_MISSION_SLUG to a mission confirmed (via the /build/tag-semaphore
// hybrid test) to have at least one product-tagged tutorial.
// ─────────────────────────────────────────────────────────────────────────────
describe('Meta tags — sm_tech_ids mission page', () => {
  it('mission page carries sm_tech_ids when product-tagged tutorials exist', async (ctx) => {
    // Hard-gated on env var: this assertion only runs when the operator supplies
    // a confirmed product-tagged mission slug. Without it the test self-skips so
    // CI stays green while the env var is unset, but cannot produce a false-green
    // when sm_tech_ids is actually missing.
    //
    // Set SMOKE_MISSION_SLUG to a mission confirmed (via /build/tag-semaphore)
    // to have at least one product-tagged tutorial before enabling this gate.
    const missionSlug = process.env.SMOKE_MISSION_SLUG;
    if (!missionSlug) { ctx.skip(); return; }

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${missionSlug}/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/name="sm_tech_ids" content="en-US,[^"]+"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sm_tech_ids — topics product detail page
//
// Hard-gated on SMOKE_PRODUCT_TOPIC_SLUG env var. Self-skips when unset;
// FAILS when set and the page is missing sm_tech_ids.
//
// Set SMOKE_PRODUCT_TOPIC_SLUG to a /topics/<slug>/ URL slug confirmed (via
// /build/tag-semaphore) to map to a tag with isActualTag=true and a non-null
// semaphoreId.
// ─────────────────────────────────────────────────────────────────────────────
describe('Meta tags — sm_tech_ids topics product detail', () => {
  it('topics product detail page carries sm_tech_ids', async (ctx) => {
    // Hard-gated on env var: this assertion only runs when the operator supplies
    // a confirmed product-tagged topic slug. Without it the test self-skips.
    //
    // Set SMOKE_PRODUCT_TOPIC_SLUG to a /topics/<slug>/ URL slug confirmed (via
    // /build/tag-semaphore) to map to a tag with isActualTag=true and a
    // non-null semaphoreId before enabling this gate.
    const topicSlug = process.env.SMOKE_PRODUCT_TOPIC_SLUG;
    if (!topicSlug) { ctx.skip(); return; }

    const res = await fetchWithRetry(`${BASE_URL}/topics/${topicSlug}/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/name="sm_tech_ids" content="en-US,[^"]+"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sm_tech_ids — absent on excluded pages (reliable, always runs)
//
// Verifies that pages OUTSIDE the tutorial/mission/topics-detail scope do NOT
// carry an sm_tech_ids meta tag. These are the pages that are excluded by
// design (browse, topics index).
// ─────────────────────────────────────────────────────────────────────────────
describe('Meta tags — sm_tech_ids absent on non-product pages', () => {
  it('topics index /topics/ carries no sm_tech_ids', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/topics/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('sm_tech_ids');
  });

  it('/browse/ carries no sm_tech_ids', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/browse/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('sm_tech_ids');
  });
});
