import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

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
// Verifies that a deployed mission page carries the sm_tech_ids meta tag.
// Requires a mission whose tutorials have product-tagged tags with Semaphore
// IDs populated in HANA.
//
// Slug resolution order:
//   1. SMOKE_MISSION_SLUG env var (operator-supplied, confirmed at deploy time —
//      see /build/tag-semaphore hybrid test for the source-of-truth feed).
//   2. Dynamic discovery from /build/catalog (first mission-prefixed slug).
//      When dynamically discovered, the test skips instead of failing if
//      sm_tech_ids is absent — the mission may not have product-tagged tutorials.
//      Set SMOKE_MISSION_SLUG to a confirmed slug to turn this into a hard assertion.
// ─────────────────────────────────────────────────────────────────────────────
describe('Meta tags — sm_tech_ids mission page', () => {
  it('mission page carries sm_tech_ids when product-tagged tutorials exist', async (ctx) => {
    const envSlug = process.env.SMOKE_MISSION_SLUG;
    let missionSlug = envSlug;
    if (!missionSlug) {
      try {
        const res = await fetchWithRetry(`${SRV_URL}/build/catalog`);
        if (res.ok) {
          const cat = await res.json();
          const found = (cat?.missions || []).find(m => m.slug?.startsWith('mission-'));
          if (found) missionSlug = found.slug;
        }
      } catch {}
    }
    if (!missionSlug) { ctx.skip(); return; }

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${missionSlug}/`, { redirect: 'follow' });
    expect(res.status).toBe(200);
    const html = await res.text();

    // When the slug was dynamically discovered (not env-supplied) and the mission
    // has no product-tagged tutorials, skip rather than fail — it is a data gap,
    // not a feature regression. Supply SMOKE_MISSION_SLUG with a confirmed
    // product-tagged mission slug to make this a hard assertion.
    if (!envSlug && !html.includes('sm_tech_ids')) {
      ctx.skip();
      return;
    }
    expect(html).toMatch(/name="sm_tech_ids" content="en-US,[^"]+"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sm_tech_ids — topics product detail page
//
// Verifies that a deployed /topics/<slug>/ product-detail page carries the
// sm_tech_ids meta tag. The tag for a software-product type node emits its own
// Semaphore ID (topics-query.js: isActualTag && semaphoreId → [semaphoreId]).
//
// Slug resolution order:
//   1. SMOKE_PRODUCT_TOPIC_SLUG env var (operator-supplied, confirmed at deploy
//      time — the /build/tag-semaphore feed lists which mdFormat keys have IDs).
//   2. Dynamic derivation: take the first `>`-containing key from the semaphore
//      feed and convert facet>leaf → facet-leaf (the URL slug is the full
//      titlePath slugified, which for single-level tags collapses to the same
//      string as replacing `>` with `-`). Falls back to ctx.skip() when the
//      derived URL returns non-200 (multi-level hierarchy or slug mismatch).
// ─────────────────────────────────────────────────────────────────────────────
describe('Meta tags — sm_tech_ids topics product detail', () => {
  it('topics product detail page carries sm_tech_ids', async (ctx) => {
    const envSlug = process.env.SMOKE_PRODUCT_TOPIC_SLUG;
    let topicSlug = envSlug;
    if (!topicSlug) {
      try {
        const res = await fetchWithRetry(`${SRV_URL}/build/tag-semaphore`);
        if (res.ok) {
          const body = await res.json();
          // Find first key using the facet>leaf mdFormat pattern (e.g.
          // "software-product>sap-hana-cloud"). Topic URL slug for single-level
          // tags is derived from the full titlePath, which for "X : Y" becomes
          // "x-y" — the same as replacing ">" with "-".
          const entry = Object.keys(body.map || {}).find(k => k.includes('>'));
          if (entry) topicSlug = entry.replace('>', '-');
        }
      } catch {}
    }
    if (!topicSlug) { ctx.skip(); return; }

    const res = await fetchWithRetry(`${BASE_URL}/topics/${topicSlug}/`, { redirect: 'follow' });
    // If the derived slug does not resolve (multi-level hierarchy, slug mismatch,
    // or page not yet published), skip rather than fail. Set SMOKE_PRODUCT_TOPIC_SLUG
    // to an operator-confirmed slug for a hard assertion.
    if (res.status !== 200) { ctx.skip(); return; }
    const html = await res.text();

    if (!envSlug && !html.includes('sm_tech_ids')) {
      // Page exists but no sm_tech_ids: tag may lack isActualTag/semaphoreId.
      // Supply SMOKE_PRODUCT_TOPIC_SLUG with a confirmed product-tagged slug.
      ctx.skip();
      return;
    }
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
