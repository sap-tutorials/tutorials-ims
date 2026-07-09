// test/unit/mcp-recommend-tools.test.js
//
// Unit tests for HomepageService recommendation MCP tools
// (get_my_recommended_tutorials, get_my_recommended_missions) and
// SearchService anonymous get_tutorial_step.
//
// (#1105 Task 13)
//
// Key design corrections vs the spec brief:
//   - HomepageForYou does NOT exist. The real entity is HomepageForYouCandidates
//     (shared persona-tagged pool: kind, targetSlug, title, description, personaTags,
//     personaWeight, sortOrder, active).
//   - Recommendations are returned as { slug, title, description } NOT
//     { slug, title, rationale, tags } (those fields don't exist on the data).
//   - rankForYou filters by personaTags matching the user's profile. An all-null
//     profile matches nothing — tests seed a user + UserLearningPreferences with
//     matching personaTags on the candidates.
//   - service.send() 3rd arg does NOT set req.user in CAP unit tests.
//     Use cds.context = { user: new cds.User({id}) } before calling send().

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const NS = 'com.sap.developers.ims';
const U_SAPID = 'rec-user@ex.com';

// ─────────────────────────────────────────────────────────────
// HomepageService recommendation tools
// ─────────────────────────────────────────────────────────────
describe('HomepageService recommendation MCP tools', () => {
  let HomepageService;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    HomepageService = await cds.serve('HomepageService').from('./srv/homepage-service');

    const { Users, UserLearningPreferences, HomepageForYouCandidates } = cds.entities(NS);

    // Seed a user whose persona is role=developer, cloud=btp.
    await INSERT.into(Users).entries({
      ID: 'rec-u1-id', sapId: U_SAPID, uuid: 'uuid-rec-u1',
      displayName: 'RecUser', email: U_SAPID,
    });
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: 'rec-u1-id', role: 'developer', cloud: 'btp', deployment: 'cloud',
    });

    // Seed HomepageForYouCandidates: two tutorials + one mission + one inactive.
    // personaTags must match the user's profile (role:developer, cloud:btp).
    await INSERT.into(HomepageForYouCandidates).entries([
      {
        ID: 'cand-t1', kind: 'tutorial', targetSlug: 'cap-getting-started',
        title: 'CAP Getting Started', description: 'Intro to CAP on BTP',
        personaTags:   ['role:developer', 'cloud:btp'],
        personaWeight: 10, sortOrder: 1, active: true,
      },
      {
        ID: 'cand-t2', kind: 'tutorial', targetSlug: 'btp-hana-cloud-intro',
        title: 'HANA Cloud Intro', description: 'Learn HANA Cloud',
        personaTags:   ['role:developer', 'cloud:btp'],
        personaWeight: 5, sortOrder: 2, active: true,
      },
      {
        ID: 'cand-m1', kind: 'mission', targetSlug: 'build-cap-mission',
        title: 'Build with CAP Mission', description: 'Multi-tutorial CAP mission',
        personaTags:   ['role:developer', 'cloud:btp'],
        personaWeight: 8, sortOrder: 1, active: true,
      },
      // inactive — must never appear
      {
        ID: 'cand-inactive', kind: 'tutorial', targetSlug: 'old-inactive-tut',
        title: 'Inactive Tutorial', description: null,
        personaTags:   ['role:developer'],
        personaWeight: 99, sortOrder: 0, active: false,
      },
    ]);

    // Seed a second user without preferences for the "no persona match" test.
    await INSERT.into(Users).entries({
      ID: 'nopref-id', sapId: 'nopref@ex.com', uuid: 'uuid-nopref',
      displayName: 'NoPrefs', email: 'nopref@ex.com',
    });
  });

  afterEach(() => {
    // Reset cds.context after each test to avoid leaking user state.
    // cds.context setter requires an object, not null — use self-reference trick
    // (see ci-node-version-mismatch.md memory note).
    const x = {};
    x.context = x;
    cds.context = x;
  });

  it('get_my_recommended_tutorials returns only kind=tutorial entries', async () => {
    cds.context = { user: new cds.User({ id: U_SAPID }) };
    const results = await HomepageService.send('get_my_recommended_tutorials', { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('description');
    }
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('cap-getting-started');
    expect(slugs).toContain('btp-hana-cloud-intro');
    // mission must NOT appear in tutorials
    expect(slugs).not.toContain('build-cap-mission');
    // inactive must NOT appear
    expect(slugs).not.toContain('old-inactive-tut');
  });

  it('get_my_recommended_tutorials returns {slug, title, description} — no rationale/tags', async () => {
    cds.context = { user: new cds.User({ id: U_SAPID }) };
    const results = await HomepageService.send('get_my_recommended_tutorials', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    // Real data shape — description not rationale
    expect(first).toHaveProperty('description');
    expect(first).not.toHaveProperty('rationale');
    expect(first).not.toHaveProperty('tags');
  });

  it('get_my_recommended_missions returns only kind=mission entries', async () => {
    cds.context = { user: new cds.User({ id: U_SAPID }) };
    const results = await HomepageService.send('get_my_recommended_missions', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('build-cap-mission');
    // tutorials must NOT appear
    expect(slugs).not.toContain('cap-getting-started');
  });

  it('get_my_recommended_tutorials returns [] for user with no persona match', async () => {
    // nopref@ex.com has no UserLearningPreferences → all-null profile.
    // All candidates have personaTags — a null profile matches nothing via rankForYou.
    cds.context = { user: new cds.User({ id: 'nopref@ex.com' }) };
    const results = await HomepageService.send('get_my_recommended_tutorials', { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it('get_my_recommended_tutorials clamps limit at 20', async () => {
    cds.context = { user: new cds.User({ id: U_SAPID }) };
    const results = await HomepageService.send('get_my_recommended_tutorials', { limit: 999 });
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('get_my_recommended_missions clamps limit at 10', async () => {
    cds.context = { user: new cds.User({ id: U_SAPID }) };
    const results = await HomepageService.send('get_my_recommended_missions', { limit: 999 });
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────────
// SearchService anonymous get_tutorial_step
// ─────────────────────────────────────────────────────────────
describe('SearchService anonymous get_tutorial_step', () => {
  let SearchService;

  const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1"><h2 class="step-title">S1 Title</h2><p>anon-step-one</p></section>
  <section class="step" data-step-number="2"><h2 class="step-title">S2 Title</h2><p>anon-step-two</p></section>
</main>`;

  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    SearchService = await cds.serve('SearchService').from('./srv/search-service');

    const { ContentManifest, ContentFiles } = cds.entities(NS);
    // ContentManifest.version is Integer; status must be 'ACTIVE' for slicer to find it.
    await INSERT.into(ContentManifest).entries({ version: 8888, status: 'ACTIVE' });
    // ContentFiles.content is LargeBinary (gzipped); field name is 'content' not 'contentGz'.
    await INSERT.into(ContentFiles).entries({
      version: 8888, slug: 'anon-tut', content: gzipSync(Buffer.from(FIXTURE_HTML)),
      mimeType: 'text/html',
    });
  });

  it('returns per-step HTML without authentication (anonymous access)', async () => {
    // Call without any cds.context user — @requires:'any' means no auth needed.
    const result = await SearchService.send('get_tutorial_step', { slug: 'anon-tut', stepNumber: 1 });
    expect(result).toBeTruthy();
    expect(result.html).toContain('anon-step-one');
    expect(result.stepTitle).toBe('S1 Title');
    expect(result.stepNumber).toBe(1);
    expect(result.totalSteps).toBe(2);
    expect(result.slug).toBe('anon-tut');
  });

  it('returns step 2 HTML correctly', async () => {
    const result = await SearchService.send('get_tutorial_step', { slug: 'anon-tut', stepNumber: 2 });
    expect(result.html).toContain('anon-step-two');
    expect(result.stepTitle).toBe('S2 Title');
  });

  it('returns null/404 for unknown slug', async () => {
    await expect(
      SearchService.send('get_tutorial_step', { slug: 'does-not-exist', stepNumber: 1 })
    ).rejects.toMatchObject({ code: 404 });
  });

  it('rejects missing slug with 400', async () => {
    await expect(
      SearchService.send('get_tutorial_step', { stepNumber: 1 })
    ).rejects.toMatchObject({ code: 400 });
  });

  it('rejects invalid stepNumber with 400', async () => {
    await expect(
      SearchService.send('get_tutorial_step', { slug: 'anon-tut', stepNumber: -1 })
    ).rejects.toMatchObject({ code: 400 });
  });
});
