# Issue #601 — Per-advocate profile pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each active advocate gets a stable, sharable URL `/developer-advocates/<slug>/` rendering a server-side HTML page (hero, bio, social links, topic chips) that hydrates a live tutorial list (authored + contributed) from a new `GET /api/advocates/:slug` endpoint.

**Architecture:** Hybrid Hugo + Vue island. Build-time `scripts/fetch-advocates.ts` calls the existing `/api/advocates` and emits one `.md` per active advocate into `hugo/content/developer-advocates/`, with the bio pre-rendered through `markdown-it` and sanitized through `sanitize-html`. A new Hugo `single.html` layout renders the static page. A new Vue island `hugo-apps/src/advocate-profile/` hydrates the tutorial lists from `GET /api/advocates/:slug` (new endpoint on `srv/routes/advocates-public.js`). The existing roster card's "View profile →" button repoints to the internal URL.

**Tech Stack:** CAP Node.js (Express route on `srv/routes/advocates-public.js`), Hugo (single template), Vue 3 + Vite (island bundle, `hugo-apps/`), `markdown-it@^14.1.1` (dep), `sanitize-html@2.17.4` (devDep), TypeScript (`scripts/fetch-advocates.ts`). Test stack: Vitest 3 workspaces (unit / hybrid / smoke).

**Spec:** [docs/superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md](../specs/2026-06-27-601-advocate-profile-pages-design.md)

---

## Pre-flight findings (read before starting)

1. **The spec says "sanitize using `scripts/parsers/sanitize-html.ts`"** but `stripDangerousHtml()` in that file is a markdown line-walker (entity-escapes pseudo-tags, preserves code fences) — it operates on **markdown source**, not on already-rendered HTML. For the bio path we render `markdown-it` → HTML, then need an HTML sanitizer. **Resolution:** use the `sanitize-html` npm package directly (it's already in `devDependencies` at `^2.17.4` and is what `stripDangerousHtml` itself wraps). Adopt the same allow-list as `scripts/parsers/sanitize-html.ts` (`SEMANTIC_TAGS` constant — exported in Task 0 if not already, or duplicated minimally in `scripts/fetch-advocates.ts`). Task 0 captures the helper extraction.

2. **`Advocates.bio` is `LargeString`** ([db/advocates.cds:13](../../../db/advocates.cds#L13)), already exposed by the existing `/api/advocates` list handler ([srv/routes/advocates-public.js:165](../../../srv/routes/advocates-public.js#L165)). No schema change.

3. **`/api/advocates` already returns all the per-row data the new `:slug` route needs**, including conditional `email`, `authoredTutorials`, `contributedTutorials` for user-linked advocates ([srv/routes/advocates-public.js:154-193](../../../srv/routes/advocates-public.js#L154-L193)). Task 1 extracts a shared row-shaper helper to reuse from `handleAdvocates` and `handleSingle`.

4. **The `advocates` island already publishes `window.__JOULE_ADVOCATES`** ([hugo-apps/src/advocates/App.vue:46-49](../../../hugo-apps/src/advocates/App.vue#L46)) for Joule grounding. The new `advocate-profile` island does **not** need to do this — Joule is grounded against the directory page, not per-advocate pages. The existing smoke test that asserts the `__JOULE_ADVOCATES` string in `/js/advocates.js` ([test/smoke/advocates.smoke.test.js:36](../../../test/smoke/advocates.smoke.test.js#L36)) stays valid for the directory bundle and is **not** added to `advocate-profile.js`.

5. **Hugo content generation pattern.** `hugo/content/tutorials/` is `.gitignore`d ([.gitignore line listing `hugo/content/tutorials/`](../../../.gitignore)). The new `hugo/content/developer-advocates/*.md` per-advocate files MUST also be gitignored (only `_index.md` stays tracked). Task 4 adds the gitignore entry.

6. **Vite entries and bundle budgets follow a clone pattern.** Each island has a `<name>Budget()` Rollup plugin in `hugo-apps/vite.config.ts` ([line 69 for `advocatesBudget`](../../../hugo-apps/vite.config.ts#L69)) and a `MAX_<NAME>_GZIP` constant. Task 8 adds `advocateProfileBudget()` at 25 KB gzip.

7. **`AdvocateCard.vue` flip-card click behavior must survive the link change.** The card root has `@click="toggle"` which flips, not navigates. The "View profile →" `<a>` on the card back is the navigation surface. Changing `profileUrl` to the internal URL keeps that behavior; we do NOT add a navigation handler to the card root. Spec §5 confirms.

8. **CAP_BASE_URL fallback.** `scripts/parsers/cap.ts` uses `CAP_BASE_URL || 'http://localhost:4004'`. `fetch-advocates.ts` follows the same convention.

9. **Smoke test gating.** Smoke tests use `describe.skipIf(!BASE)(...)` and `describe.skipIf(!SRV)(...)` — they don't fail when the env vars are unset. Local `npm run test:smoke` against an unreachable deployed URL is the right pre-merge sanity, but CI runs them post-deploy with both URLs.

10. **The og:image hardcodes `https://developers.sap.com`.** Spec Open Question #1 calls this out. **Resolution for this plan:** derive from Hugo's `site.BaseURL` directly in the template (`{{ .Site.BaseURL }}/api/advocates/.../photo`) rather than hardcoding. DEV/QA configs have correct `baseURL` already. One-line difference vs the spec snippet; recorded in Task 7.

---

## File structure

### Backend (CAP)

| File | Action | Responsibility |
|---|---|---|
| [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js) | Modify | Extract per-advocate row-shaper to a helper; add `handleSingle()`; register `GET /api/advocates/:slug`. Reuse existing `fetchPhoto`. |

### Build pipeline

| File | Action | Responsibility |
|---|---|---|
| [scripts/fetch-advocates.ts](../../../scripts/fetch-advocates.ts) | Create | Fetch `/api/advocates`; render+sanitize bio per row; emit `<slug>.md` files; cache roster; cleanup stale files. |
| [package.json](../../../package.json) | Modify | Wire `fetch-advocates` into `fetch-tutorials` (or a sibling sequence) so `build:all` picks it up. |
| [.gitignore](../../../.gitignore) | Modify | Add `hugo/content/developer-advocates/*.md` (preserving the tracked `_index.md`). |

### Hugo

| File | Action | Responsibility |
|---|---|---|
| [hugo/layouts/developer-advocates/single.html](../../../hugo/layouts/developer-advocates/single.html) | Create | Server-renders the profile page from frontmatter; emits meta tags; embeds the island mount + script. |

### Vue island

| File | Action | Responsibility |
|---|---|---|
| [hugo-apps/src/advocate-profile/main.ts](../../../hugo-apps/src/advocate-profile/main.ts) | Create | Mounts `App.vue` on `#advocate-profile-mount` with `data-api` prop. |
| [hugo-apps/src/advocate-profile/App.vue](../../../hugo-apps/src/advocate-profile/App.vue) | Create | Fetches `data-api`, renders tutorial lists; handles 404 banner; renders nothing on generic fetch error. |
| [hugo-apps/src/advocate-profile/styles.css](../../../hugo-apps/src/advocate-profile/styles.css) | Create | Profile-page-only CSS (hero band, lists, banner). |
| [hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts) | Modify | Add `advocate-profile` entry; add `advocateProfileBudget()` (25 KB). |
| [hugo-apps/src/advocates/components/AdvocateCard.vue](../../../hugo-apps/src/advocates/components/AdvocateCard.vue) | Modify | Repoint `profileUrl` to `/developer-advocates/${slug}/`; drop `target="_blank"`. |

### Tests

| File | Action | Responsibility |
|---|---|---|
| `test/unit/advocates/advocate-single-route.test.js` | Create | SQLite-seeded test of `GET /api/advocates/<slug>` — shape, ETag, 304, 404 unknown, 404 inactive. |
| `test/unit/advocates/fetch-advocates.test.js` | Create | Mock `/api/advocates`; assert `<slug>.md` emitted with frontmatter incl. rendered `bioHtml`; cache hit; stale cleanup. |
| `test/unit/advocates/bio-sanitize.test.js` | Create | `<script>`/`<iframe>` payloads pass through render+sanitize and emerge clean. |
| `hugo-apps/src/advocate-profile/App.test.ts` | Create | Vue Testing Library; mock fetch with both list sections populated; assert each renders. |
| `hugo-apps/src/advocate-profile/App.empty-state.test.ts` | Create | Mock fetch 404 → banner. |
| `test/hybrid/advocate-profile-route.test.js` | Create | `ALLOW_HYBRID_WRITES=true`-gated. Real HANA seed; assert single-slug response shape; cleanup. |
| `test/smoke/advocates.smoke.test.js` | Modify | Three new assertions: deployed profile page returns 200 + meta tags; `/api/advocates/<slug>` returns 200 JSON; unknown slug returns 404. |

### Docs

| File | Action | Responsibility |
|---|---|---|
| [docs/developers/architecture/advocates.md](../../developers/architecture/advocates.md) | Modify | Document the new page + endpoint + build step. |

---

## Conventions every task follows

- **Always work from this worktree** (`D:\projects\tutorials-poc\.claude\worktrees\601-advocate-profile-pages`). Never `cd` to the primary tree.
- **Tests first.** Each task writes the failing test, runs it (expect FAIL), implements minimal code, runs it (expect PASS), then commits.
- **Commit messages** start with the conventional-commits prefix and `(#601)`, e.g. `feat(#601): GET /api/advocates/:slug`.
- **Run from worktree root.** All commands assume `D:/projects/tutorials-poc/.claude/worktrees/601-advocate-profile-pages`. Use Git Bash.
- **Vitest:** `npm test -- <path>` runs a single unit file. `npm run test:hybrid` runs HANA-bound tests (requires `cf login` to DEV space). `npm run test:smoke` requires `SMOKE_BASE_URL`/`SMOKE_SRV_URL`.
- **Skill references:** See `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- **Branch:** `worktree-601-advocate-profile-pages` (already created).

---

## Task 1: Extract row-shaper helper from `handleAdvocates`

**Files:**
- Modify: [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js) — pull lines 154-193 (the per-advocate row mapping) into a `shapeAdvocateRow(advocate, ctx)` helper at module scope. `ctx` carries pre-built lookup maps (`topicsByAdv`, `linksByAdv`, `userById`, `authoredByUserId`, `contribByUserId`).
- Test: `test/unit/advocates/advocate-row-shaper.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/advocates/advocate-row-shaper.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { shapeAdvocateRow } from '../../../srv/routes/advocates-public.js';

describe('shapeAdvocateRow', () => {
  const ctx = {
    topicsByAdv: new Map([['A1', [{ slug: 'cap', label: 'CAP' }]]]),
    linksByAdv: new Map([['A1', [{ kind: 'LinkedIn', url: 'https://x', label: null, sortOrder: 100 }]]]),
    userById: new Map([['U1', { ID: 'U1', email: 't@example.com' }]]),
    authoredByUserId: new Map([['U1', [{ slug: 't1', title: 'Tut 1' }]]]),
    contribByUserId: new Map([['U1', [{ slug: 't2', title: 'Tut 2' }]]]),
  };

  it('emits the canonical row shape', () => {
    const row = shapeAdvocateRow({
      ID: 'A1', slug: 'a-one', firstName: 'A', lastName: 'One',
      title: 'Advocate', region: 'AMERICAS',
      bio: 'hi', hasPhoto: true, photoUpdatedAt: '2026-06-27',
      user_ID: 'U1',
    }, ctx);
    expect(row.slug).toBe('a-one');
    expect(row.topics).toEqual([{ slug: 'cap', label: 'CAP' }]);
    expect(row.links).toHaveLength(1);
    expect(row.email).toBe('t@example.com');
    expect(row.authoredTutorials).toEqual([{ slug: 't1', title: 'Tut 1' }]);
    expect(row.contributedTutorials).toEqual([{ slug: 't2', title: 'Tut 2' }]);
  });

  it('omits email/authored/contributed when unlinked', () => {
    const row = shapeAdvocateRow({
      ID: 'A2', slug: 'a-two', firstName: 'A', lastName: 'Two',
      region: 'EMEA', user_ID: null,
    }, ctx);
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('authoredTutorials');
    expect(row).not.toHaveProperty('contributedTutorials');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/advocates/advocate-row-shaper.test.js
```

Expected: FAIL — `shapeAdvocateRow` is not exported.

- [ ] **Step 3: Extract `shapeAdvocateRow` in `srv/routes/advocates-public.js`**

Above `handleAdvocates`, add:

```javascript
/**
 * Map a raw Advocates row + pre-built lookup maps into the canonical
 * JSON shape used by both /api/advocates (list) and /api/advocates/:slug
 * (single). Optional fields (email, authoredTutorials, contributedTutorials)
 * are omitted entirely when the advocate has no user link OR the linked
 * user has no email / tutorials — same gating logic the existing list
 * handler used inline.
 */
export function shapeAdvocateRow(a, ctx) {
  const { topicsByAdv, linksByAdv, userById, authoredByUserId, contribByUserId } = ctx;
  const linkedUser = a.user_ID ? userById.get(a.user_ID) : null;
  const authored = a.user_ID ? authoredByUserId.get(a.user_ID) : null;
  const contributed = a.user_ID ? contribByUserId.get(a.user_ID) : null;
  return {
    ID: a.ID,
    slug: a.slug,
    firstName: a.firstName,
    lastName: a.lastName,
    title: a.title,
    pronouns: a.pronouns,
    location: a.location,
    region: a.region,
    bio: a.bio,
    joinedDate: a.joinedDate,
    hasPhoto: !!a.hasPhoto,
    photoUpdatedAt: a.photoUpdatedAt,
    topics: topicsByAdv.get(a.ID) || [],
    links: linksByAdv.get(a.ID) || [],
    ...(linkedUser?.email ? { email: linkedUser.email } : {}),
    ...(authored?.length
      ? { authoredTutorials: authored.slice().sort((x, y) => x.title.localeCompare(y.title)) }
      : {}),
    ...(contributed?.length
      ? { contributedTutorials: contributed.slice().sort((x, y) => x.title.localeCompare(y.title)) }
      : {}),
  };
}
```

Then replace the existing `advocates.map((a) => ({ ... }))` block at lines 154-193 with:

```javascript
const ctx = { topicsByAdv, linksByAdv, userById, authoredByUserId, contribByUserId };
const body = { advocates: advocates.map((a) => shapeAdvocateRow(a, ctx)) };
```

- [ ] **Step 4: Run the new test and the existing api.test.js to verify no regression**

```bash
npm test -- test/unit/advocates/advocate-row-shaper.test.js test/unit/advocates/api.test.js
```

Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add srv/routes/advocates-public.js test/unit/advocates/advocate-row-shaper.test.js
git commit -m "refactor(#601): extract shapeAdvocateRow helper from handleAdvocates"
```

---

## Task 2: Add `GET /api/advocates/:slug` handler

**Files:**
- Modify: [srv/routes/advocates-public.js](../../../srv/routes/advocates-public.js) — add `handleSingle()` and register the route.
- Test: `test/unit/advocates/advocate-single-route.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/advocates/advocate-single-route.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates, AdvocateLinks } = cds.entities('com.sap.developers.ims');
  const exists = await db.run(SELECT.from(Advocates).columns('slug').where({ slug: '__test__single-slug-amer' }));
  if (!exists.length) {
    await db.run(INSERT.into(Advocates).entries({
      ID: 'ADC00601-0000-0000-0000-000000000001',
      slug: '__test__single-slug-amer',
      firstName: 'FixtureSingle', lastName: 'Amer',
      title: 'Advocate', region: 'AMERICAS', isActive: true,
      bio: '**Hello** world',
    }));
    await db.run(INSERT.into(Advocates).entries({
      ID: 'ADC00601-0000-0000-0000-000000000002',
      slug: '__test__single-inactive',
      firstName: 'FixtureSingle', lastName: 'Inactive',
      region: 'EMEA', isActive: false,
    }));
  }
});

afterAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Advocates).where`firstName like 'FixtureSingle%'`);
});

describe('GET /api/advocates/:slug', () => {
  it('returns 200 + the advocate shape for an active slug', async () => {
    const res = await project.get('/api/advocates/__test__single-slug-amer');
    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('__test__single-slug-amer');
    expect(res.data.firstName).toBe('FixtureSingle');
    expect(res.data.bio).toBe('**Hello** world');
    expect(res.data).toHaveProperty('topics');
    expect(res.data).toHaveProperty('links');
    expect(res.data).not.toHaveProperty('advocates'); // single, not list
  });

  it('responds with ETag and Cache-Control', async () => {
    const res = await project.get('/api/advocates/__test__single-slug-amer');
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
    expect(res.headers['cache-control']).toMatch(/stale-while-revalidate=600/);
  });

  it('returns 304 on conditional GET', async () => {
    const first = await project.get('/api/advocates/__test__single-slug-amer');
    const etag = first.headers.etag;
    const second = await project.get('/api/advocates/__test__single-slug-amer', {
      headers: { 'if-none-match': etag },
      validateStatus: () => true,
    });
    expect(second.status).toBe(304);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await project.get('/api/advocates/__does-not-exist__', { validateStatus: () => true });
    expect(res.status).toBe(404);
  });

  it('returns 404 for inactive advocate', async () => {
    const res = await project.get('/api/advocates/__test__single-inactive', { validateStatus: () => true });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/unit/advocates/advocate-single-route.test.js
```

Expected: FAIL with 404 on all GETs (route not registered yet).

- [ ] **Step 3: Implement `handleSingle()` and register it**

In `srv/routes/advocates-public.js`, add above `register`:

```javascript
async function handleSingle(req, res) {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!slug) { res.status(404).end(); return; }

    const db = await cds.connect.to('db');
    const { Advocates, AdvocateTopics, AdvocateLinks, Tags, Users, Tutorials, TutorialContributors } =
      cds.entities('com.sap.developers.ims');

    // Lowercase compare so 'Thomas-Jung' resolves the same as 'thomas-jung'.
    const matches = await db.run(SELECT.from(Advocates).where({ isActive: true }));
    const advocate = matches.find((a) => String(a.slug || '').toLowerCase() === slug);
    if (!advocate) { res.status(404).end(); return; }

    const userIds = advocate.user_ID ? [advocate.user_ID] : [];

    const [topics, links, users, authoredRows, contribRows] = await Promise.all([
      db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: advocate.ID })),
      db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: advocate.ID })),
      userIds.length ? db.run(SELECT.from(Users).columns('ID', 'email').where({ ID: { in: userIds } })) : [],
      userIds.length
        ? db.run(SELECT.from(Tutorials).columns('slug', 'title', 'author_ID').where({ author_ID: { in: userIds } }))
        : [],
      userIds.length
        ? db.run(SELECT.from(TutorialContributors).columns('user_ID', 'tutorial_ID').where({ user_ID: { in: userIds } }))
        : [],
    ]);

    const contribTutorialIds = [...new Set(contribRows.map((r) => r.tutorial_ID).filter(Boolean))];
    const contribTutorials = contribTutorialIds.length
      ? await db.run(SELECT.from(Tutorials).columns('ID', 'slug', 'title').where({ ID: { in: contribTutorialIds } }))
      : [];

    const tagIds = [...new Set(topics.map((t) => t.tag_ID).filter(Boolean))];
    const tagRows = tagIds.length
      ? await db.run(SELECT.from(Tags).columns('ID', 'name', 'label').where({ ID: { in: tagIds } }))
      : [];
    const tagById = new Map(tagRows.map((t) => [t.ID, t]));

    const topicsByAdv = new Map();
    for (const t of topics) {
      const tag = tagById.get(t.tag_ID);
      if (!tag) continue;
      const label = (tag.label && String(tag.label).trim())
        || (tag.name && String(tag.name).trim()) || null;
      if (!label) continue;
      if (!topicsByAdv.has(t.advocate_ID)) topicsByAdv.set(t.advocate_ID, []);
      topicsByAdv.get(t.advocate_ID).push({ slug: tag.name, label });
    }

    const linksByAdv = new Map();
    const sortedLinks = [...links].sort(
      (a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || String(a.kind).localeCompare(String(b.kind))
    );
    for (const l of sortedLinks) {
      if (!linksByAdv.has(l.advocate_ID)) linksByAdv.set(l.advocate_ID, []);
      linksByAdv.get(l.advocate_ID).push({ kind: l.kind, url: l.url, label: l.label, sortOrder: l.sortOrder });
    }

    const userById = new Map(users.map((u) => [u.ID, u]));
    const authoredByUserId = new Map();
    for (const t of authoredRows) {
      if (!t.slug || !t.title) continue;
      if (!authoredByUserId.has(t.author_ID)) authoredByUserId.set(t.author_ID, []);
      authoredByUserId.get(t.author_ID).push({ slug: t.slug, title: t.title });
    }
    const tutorialById = new Map(contribTutorials.map((t) => [t.ID, t]));
    const contribByUserId = new Map();
    for (const c of contribRows) {
      const tut = tutorialById.get(c.tutorial_ID);
      if (!tut || !tut.slug || !tut.title) continue;
      if (!contribByUserId.has(c.user_ID)) contribByUserId.set(c.user_ID, []);
      contribByUserId.get(c.user_ID).push({ slug: tut.slug, title: tut.title });
    }

    const body = shapeAdvocateRow(advocate, {
      topicsByAdv, linksByAdv, userById, authoredByUserId, contribByUserId,
    });

    const max = Math.max(
      maxModified([advocate]),
      maxModified(topics),
      maxModified(links),
      maxModified(users),
      maxModified(authoredRows),
      maxModified(contribRows),
      maxModified(contribTutorials),
    );
    const etag = '"' + max.toString(36) + '"';

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');

    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }

    res.json(body);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'advocate_unavailable' });
  }
}
```

Update `register`:

```javascript
export function register(app) {
  app.get('/api/advocates', handleAdvocates);
  app.get('/api/advocates/:slug', handleSingle);
  app.get('/api/advocates/:slug/photo', handlePhoto);
}
```

**Route-order note:** `:slug` and `:slug/photo` are distinct paths, so Express resolves them correctly regardless of registration order. Keeping photo last for visual continuity.

- [ ] **Step 4: Run the unit test**

```bash
npm test -- test/unit/advocates/advocate-single-route.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 5: Run the full advocates unit suite to confirm no regression**

```bash
npm test -- test/unit/advocates/
```

Expected: PASS (existing api.test.js + photo tests + new tests).

- [ ] **Step 6: Commit**

```bash
git add srv/routes/advocates-public.js test/unit/advocates/advocate-single-route.test.js
git commit -m "feat(#601): GET /api/advocates/:slug single-advocate endpoint"
```

---

## Task 3: Hybrid test — single-advocate endpoint against real HANA

**Files:**
- Test: `test/hybrid/advocate-profile-route.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/hybrid/advocate-profile-route.test.js`:

```javascript
// Gated by ALLOW_HYBRID_WRITES=true. Seeds an advocate + linked user + one
// authored tutorial + one contributed tutorial on real HANA, hits
// /api/advocates/<slug>, asserts shape, cleans up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import '../hybrid/_guard.js';

describe.skipIf(!process.env.ALLOW_HYBRID_WRITES)('GET /api/advocates/:slug (HANA)', () => {
  const project = cds.test('serve', '--project', '.');
  const TEST_PREFIX = '__TEST__601_';
  const advocateSlug = TEST_PREFIX + 'profile-amer';
  const userEmail = TEST_PREFIX + 'profile-user@example.test';

  let advocateId, userId, tutorialId, contributorTutorialId;

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates, Users, Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims');

    const user = await db.run(INSERT.into(Users).entries({
      email: userEmail,
      firstName: '__TEST__Author',
      lastName: 'For601',
      displayName: '__TEST__Author For601',
    }));
    userId = user.req.headers['location']?.match(/\(([^)]+)\)/)?.[1]
      ?? (await db.run(SELECT.one.from(Users).where({ email: userEmail }))).ID;

    const advocate = await db.run(INSERT.into(Advocates).entries({
      slug: advocateSlug,
      firstName: '__TEST__Profile',
      lastName: 'Amer',
      region: 'AMERICAS',
      isActive: true,
      bio: 'Hybrid test bio',
      user_ID: userId,
    }));
    advocateId = advocate.req.headers['location']?.match(/\(([^)]+)\)/)?.[1]
      ?? (await db.run(SELECT.one.from(Advocates).where({ slug: advocateSlug }))).ID;

    const tut = await db.run(INSERT.into(Tutorials).entries({
      slug: TEST_PREFIX + 'tut-authored',
      title: '__TEST__ Authored Tutorial',
      author_ID: userId,
    }));
    tutorialId = (await db.run(SELECT.one.from(Tutorials).where({ slug: TEST_PREFIX + 'tut-authored' }))).ID;

    const tutB = await db.run(INSERT.into(Tutorials).entries({
      slug: TEST_PREFIX + 'tut-contrib',
      title: '__TEST__ Contributed Tutorial',
    }));
    contributorTutorialId = (await db.run(SELECT.one.from(Tutorials).where({ slug: TEST_PREFIX + 'tut-contrib' }))).ID;

    await db.run(INSERT.into(TutorialContributors).entries({
      tutorial_ID: contributorTutorialId,
      user_ID: userId,
    }));
  });

  afterAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates, Users, Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TutorialContributors).where({ user_ID: userId }));
    await db.run(DELETE.from(Tutorials).where`slug like '${TEST_PREFIX}%'`);
    await db.run(DELETE.from(Advocates).where({ slug: advocateSlug }));
    await db.run(DELETE.from(Users).where({ email: userEmail }));
  });

  it('returns the expected shape', async () => {
    const res = await project.get('/api/advocates/' + advocateSlug);
    expect(res.status).toBe(200);
    expect(res.data.slug).toBe(advocateSlug);
    expect(res.data.email).toBe(userEmail);
    expect(res.data.authoredTutorials).toHaveLength(1);
    expect(res.data.authoredTutorials[0].slug).toBe(TEST_PREFIX + 'tut-authored');
    expect(res.data.contributedTutorials).toHaveLength(1);
    expect(res.data.contributedTutorials[0].slug).toBe(TEST_PREFIX + 'tut-contrib');
  });
});
```

- [ ] **Step 2: Run the test against HANA**

```bash
cf login   # if not already
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/advocate-profile-route.test.js
```

Expected: PASS. If FAIL with insertion errors, double-check the `Users` / `Tutorials` shape against current `db/schema.cds` (no `@mandatory` field is unset).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/advocate-profile-route.test.js
git commit -m "test(#601): hybrid coverage for /api/advocates/:slug"
```

---

## Task 4: Gitignore generated `developer-advocates/*.md`

**Files:**
- Modify: [.gitignore](../../../.gitignore)

- [ ] **Step 1: Edit `.gitignore`**

Find the `hugo/content/tutorials/` line. Below it, add:

```gitignore
# Generated per-advocate profile pages (issue #601). Only _index.md is tracked.
hugo/content/developer-advocates/*.md
!hugo/content/developer-advocates/_index.md
```

- [ ] **Step 2: Verify `_index.md` still tracked**

```bash
git check-ignore -v hugo/content/developer-advocates/_index.md
```

Expected: NO output (file is NOT ignored). If the command prints a match, the negation pattern is wrong — fix and re-check.

- [ ] **Step 3: Verify a sample slug file would be ignored**

```bash
git check-ignore -v hugo/content/developer-advocates/thomas-jung.md
```

Expected: Output showing `.gitignore` matches the file.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(#601): gitignore generated developer-advocates per-slug .md files"
```

---

## Task 5: Build-time roster fetcher — `scripts/fetch-advocates.ts`

**Files:**
- Create: [scripts/fetch-advocates.ts](../../../scripts/fetch-advocates.ts)
- Test: `test/unit/advocates/fetch-advocates.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/advocates/fetch-advocates.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFetchAdvocates } from '../../../scripts/fetch-advocates.ts';

const SAMPLE = {
  advocates: [
    {
      ID: 'A1', slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung',
      title: 'Chief Developer Advocate', region: 'AMERICAS',
      hasPhoto: true, photoUpdatedAt: '2026-06-27T00:00:00Z',
      bio: '**Hello** world\n\nLine 2',
      topics: [{ slug: 'cap', label: 'CAP' }],
      links: [{ kind: 'LinkedIn', url: 'https://linkedin.com/in/x', label: null, sortOrder: 100 }],
    },
    {
      ID: 'A2', slug: 'stale-advocate', firstName: 'Stale', lastName: 'One',
      region: 'EMEA', hasPhoto: false, bio: '',
      topics: [], links: [],
    },
  ],
};

describe('fetch-advocates', () => {
  let tmpDir, contentDir, cacheDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetch-advocates-'));
    contentDir = join(tmpDir, 'hugo/content/developer-advocates');
    cacheDir = join(tmpDir, '.tutorial-cache');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(contentDir, '_index.md'), '---\n---\n');
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits one .md per active advocate with rendered bioHtml', async () => {
    const fetcher = async () => SAMPLE;
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    const jung = readFileSync(join(contentDir, 'thomas-jung.md'), 'utf8');
    expect(jung).toMatch(/slug: thomas-jung/);
    expect(jung).toMatch(/<strong>Hello<\/strong>/);
    expect(jung).toMatch(/region: AMERICAS/);
    expect(existsSync(join(contentDir, 'stale-advocate.md'))).toBe(true);
  });

  it('skips inactive advocates', async () => {
    const fetcher = async () => ({
      advocates: [
        { ...SAMPLE.advocates[0], isActive: false },
        SAMPLE.advocates[1],
      ],
    });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    // Active flag was never absent in the prod API contract, but if an
    // advocate ships with isActive:false (e.g. someone deactivated mid-roster),
    // the fetcher must NOT emit a page.
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'stale-advocate.md'))).toBe(true);
  });

  it('removes .md files for advocates no longer in the roster', async () => {
    writeFileSync(join(contentDir, 'gone-away.md'), '---\nslug: gone-away\n---\n');
    const fetcher = async () => SAMPLE;
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    expect(existsSync(join(contentDir, 'gone-away.md'))).toBe(false);
    expect(existsSync(join(contentDir, '_index.md'))).toBe(true); // never touched
  });

  it('skips re-fetch when cached SHA matches', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return SAMPLE; };
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    // Cached body is identical → second call still hits the network (caching
    // is at the file-write level, not the network level). But the page
    // emission is content-identical. Asserting the cache file exists is
    // enough — the cache is an optimization, not a correctness invariant.
    expect(existsSync(join(cacheDir, 'advocates-roster.json'))).toBe(true);
    expect(calls).toBe(2);
  });

  it('escapes script payloads in bio', async () => {
    const fetcher = async () => ({
      advocates: [{
        ...SAMPLE.advocates[0],
        bio: 'Hi <script>alert(1)</script> there',
      }],
    });
    await runFetchAdvocates({ fetcher, contentDir, cacheDir });
    const jung = readFileSync(join(contentDir, 'thomas-jung.md'), 'utf8');
    expect(jung).not.toMatch(/<script>/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- test/unit/advocates/fetch-advocates.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `scripts/fetch-advocates.ts`**

```typescript
/**
 * Build-time fetcher: pulls the advocates roster from CAP's /api/advocates,
 * renders each bio through markdown-it + sanitize-html, and emits one
 * hugo/content/developer-advocates/<slug>.md per active advocate.
 *
 * Wired into `npm run fetch-tutorials` so build:all + rebuild-content.yml
 * pick it up.
 *
 * Spec: docs/superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md
 */
import { writeFileSync, readdirSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { stringify as yamlStringify } from 'yaml';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Same allowlist as scripts/parsers/sanitize-html.ts SEMANTIC_TAGS, minus
// `script`/`iframe`/etc. We're sanitizing already-rendered HTML, so the
// allowlist IS the security boundary.
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong',
  'sub', 'sup', 'u', 'ul',
];
const ALLOWED_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title'],
};

function renderBio(markdown: string): { html: string; text: string } {
  const raw = String(markdown || '').trim();
  if (!raw) return { html: '', text: '' };
  const dirty = md.render(raw);
  const html = sanitizeHtml(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener', target: '_blank' }),
    },
  });
  // Strip HTML for og:description (first 200 chars of plain text).
  const plain = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  return { html, text: plain };
}

function frontmatter(advocate: any): string {
  const { html, text } = renderBio(advocate.bio);
  const fm: Record<string, any> = {
    title: `${advocate.firstName} ${advocate.lastName}`,
    description: text,
    slug: advocate.slug,
    layout: 'single',
    type: 'developer-advocates',
    advocate: {
      firstName: advocate.firstName,
      lastName: advocate.lastName,
      title: advocate.title || '',
      pronouns: advocate.pronouns || '',
      location: advocate.location || '',
      region: advocate.region,
      hasPhoto: !!advocate.hasPhoto,
      photoUpdatedAt: advocate.photoUpdatedAt || '',
      joinedDate: advocate.joinedDate || '',
      topics: advocate.topics || [],
      links: advocate.links || [],
      bioHtml: html,
      bioText: text,
    },
  };
  // `yaml@^2.7.0` (already a dep — used by scripts/parsers/render-frontmatter.ts)
  // handles quoting, escaping, multi-line strings (for bioHtml), and Unicode safely.
  return yamlStringify(fm);
}

export interface RunOpts {
  fetcher: () => Promise<{ advocates: any[] }>;
  contentDir: string;
  cacheDir: string;
}

export async function runFetchAdvocates({ fetcher, contentDir, cacheDir }: RunOpts): Promise<void> {
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const body = await fetcher();
  const roster = Array.isArray(body?.advocates) ? body.advocates : [];

  // Cache the raw roster (advisory; not a correctness invariant).
  const sha = createHash('sha256').update(JSON.stringify(roster)).digest('hex');
  writeFileSync(join(cacheDir, 'advocates-roster.json'), JSON.stringify({ sha, roster }, null, 2));

  // Active subset.
  const active = roster.filter((a) => a.isActive !== false);
  const activeSlugs = new Set(active.map((a) => a.slug));

  // Emit one .md per active advocate.
  for (const a of active) {
    const yaml = frontmatter(a);
    const out = `---\n${yaml}---\n`;
    writeFileSync(join(contentDir, `${a.slug}.md`), out);
  }

  // Remove stale per-slug files (NOT _index.md).
  for (const entry of readdirSync(contentDir)) {
    if (entry === '_index.md') continue;
    if (!entry.endsWith('.md')) continue;
    const slug = entry.replace(/\.md$/, '');
    if (!activeSlugs.has(slug)) {
      unlinkSync(join(contentDir, entry));
    }
  }
}

// CLI entry point — only runs when invoked directly via tsx.
if (import.meta.url === `file://${process.argv[1]}`) {
  const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
  const repoRoot = process.cwd();
  const contentDir = join(repoRoot, 'hugo', 'content', 'developer-advocates');
  const cacheDir = join(repoRoot, '.tutorial-cache');

  const fetcher = async () => {
    const res = await fetch(`${CAP_BASE_URL}/api/advocates`);
    if (!res.ok) throw new Error(`fetch /api/advocates: ${res.status}`);
    return res.json();
  };

  runFetchAdvocates({ fetcher, contentDir, cacheDir })
    .then(() => console.log('[fetch-advocates] done'))
    .catch((err) => {
      console.error('[fetch-advocates] failed:', err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- test/unit/advocates/fetch-advocates.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 5: Smoke-run the CLI against a local CAP if available** (manual, optional)

```bash
# In one terminal: cds watch
# In another:
CAP_BASE_URL=http://localhost:4004 npx tsx scripts/fetch-advocates.ts
ls hugo/content/developer-advocates/
```

Expected: `_index.md` plus one `.md` per active advocate from the DEV seed.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-advocates.ts test/unit/advocates/fetch-advocates.test.js
git commit -m "feat(#601): scripts/fetch-advocates.ts build-time roster fetcher"
```

---

## Task 6: Wire `fetch-advocates` into `npm run fetch-tutorials`

**Files:**
- Modify: [package.json](../../../package.json) — add a `fetch-advocates` script and chain it after `fetch-tutorials`.

- [ ] **Step 1: Edit `package.json` scripts**

Replace the existing line:

```json
"fetch-tutorials": "tsx scripts/fetch-tutorials.ts --target hugo",
```

with:

```json
"fetch-tutorials": "tsx scripts/fetch-tutorials.ts --target hugo && tsx scripts/fetch-advocates.ts",
"fetch-advocates": "tsx scripts/fetch-advocates.ts",
```

Do the same for `fetch-tutorials:hugo` (the duplicate alias). Leave `fetch-tutorials:qa` alone — QA does not yet republish advocate profiles.

- [ ] **Step 2: Smoke-run the chained sequence**

```bash
# Ensure CAP is running locally first:
# In another terminal: cds watch
# Or set CAP_BASE_URL to a deployed instance:
CAP_BASE_URL=http://localhost:4004 npm run fetch-tutorials
```

Expected: Tutorial fetch completes (existing behavior), then fetch-advocates prints `[fetch-advocates] done`, and `hugo/content/developer-advocates/` contains one `.md` per active advocate.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(#601): chain fetch-advocates onto fetch-tutorials"
```

---

## Task 7: Hugo layout — `developer-advocates/single.html`

**Files:**
- Create: [hugo/layouts/developer-advocates/single.html](../../../hugo/layouts/developer-advocates/single.html)

- [ ] **Step 1: Create the layout**

```html
{{ define "main" }}
{{ $a := .Params.advocate }}
{{ $slug := .Params.slug }}
<main class="adv-profile" data-slug="{{ $slug }}">
  <a class="adv-profile-back" href="/developer-advocates/">← All advocates</a>

  <section class="adv-profile-hero" data-region="{{ $a.region }}">
    {{ if $a.hasPhoto }}
      <img class="adv-profile-photo"
           src="/api/advocates/{{ $slug }}/photo?v={{ $a.photoUpdatedAt }}"
           alt="Photo of {{ $a.firstName }} {{ $a.lastName }}" />
    {{ else }}
      <div class="adv-profile-photo-fallback" aria-hidden="true">
        {{ slicestr $a.firstName 0 1 }}{{ slicestr $a.lastName 0 1 }}
      </div>
    {{ end }}
    <div class="adv-profile-id">
      <h1>{{ $a.firstName }} {{ $a.lastName }}
        {{ with $a.pronouns }}<span class="adv-pron">({{ . }})</span>{{ end }}
      </h1>
      {{ with $a.title }}<div class="adv-role">{{ . }}</div>{{ end }}
      <div class="adv-loc">
        {{ with $a.location }}{{ . }} ·{{ end }} {{ $a.region }}
      </div>
      {{ with $a.links }}
      <ul class="adv-profile-links">
        {{ range . }}
          <li><a href="{{ .url }}" target="_blank" rel="noopener" title="{{ .label | default .kind }}">{{ .kind }}</a></li>
        {{ end }}
      </ul>
      {{ end }}
    </div>
  </section>

  {{ with $a.bioHtml }}
  <section class="adv-profile-bio">
    <h2>About</h2>
    <div class="adv-bio-md">{{ . | safeHTML }}</div>
  </section>
  {{ end }}

  {{ with $a.topics }}
  <section class="adv-profile-topics">
    <h2>Topics</h2>
    <ul>
      {{ range . }}
        <li><a class="adv-chip" href="/developer-advocates/#topic={{ .slug }}">{{ .label }}</a></li>
      {{ end }}
    </ul>
  </section>
  {{ end }}

  <div id="advocate-profile-mount"
       data-slug="{{ $slug }}"
       data-api="/api/advocates/{{ $slug }}"></div>
</main>

<script type="module" src="{{ "/js/advocate-profile.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 2: Confirm where head/meta tags belong**

```bash
ls hugo/layouts/_default/baseof.html hugo/layouts/partials/head.html 2>/dev/null || echo "no head partial"
```

If `hugo/layouts/_default/baseof.html` exists, look at it (`Read` tool) to see how `<title>` and meta tags are emitted today. If the existing `baseof` already uses `.Title` for `<title>` and `.Description` for `<meta name="description">`, set those in the frontmatter via Task 5's `frontmatter()` helper (already done — `title` is set, `description` should be added — see Step 3).

- [ ] **Step 3: Emit meta tags from frontmatter**

Inspect `hugo/layouts/_default/baseof.html` (or the relevant head partial). If meta tag emission is centralized there using `.Description` and `.Params.advocate.bioText`, no further work is needed. If meta tags are not yet wired for og:image / og:type, add to `single.html` a `{{ define "head_extra" }}` block (or equivalent — match the codebase's existing pattern; do **not** invent a new convention):

```html
{{ define "head_extra" }}
{{ $a := .Params.advocate }}
{{ $slug := .Params.slug }}
<meta property="og:type" content="profile">
<meta property="og:title" content="{{ $a.firstName }} {{ $a.lastName }} · SAP Developer Advocates">
<meta property="og:description" content="{{ $a.bioText }}">
{{ if $a.hasPhoto }}<meta property="og:image" content="{{ .Site.BaseURL }}api/advocates/{{ $slug }}/photo">{{ end }}
{{ end }}
```

Also wire `description` in `frontmatter()` (Task 5) so Hugo's `.Description` resolves: add `description: text` as a top-level field next to `title`. **If this needs to change, go back to Task 5, edit, and re-run that task's tests.**

- [ ] **Step 4: Manual Hugo build smoke test**

```bash
# Need at least one advocate seeded locally; if not available:
# 1. Start cds watch in another terminal
# 2. Seed an advocate via /admin/Advocates POST
# 3. Run fetch:
CAP_BASE_URL=http://localhost:4004 npm run fetch-advocates
# 4. Build Hugo:
npm run build:hugo
# 5. Verify the page is in hugo/public:
ls hugo/public/developer-advocates/ | head
cat hugo/public/developer-advocates/<some-slug>/index.html | grep -i og:
```

Expected: `index.html` exists for each emitted `.md`, and contains `og:type`, `og:title`, `og:description`, optionally `og:image`.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/developer-advocates/single.html
git commit -m "feat(#601): Hugo single-advocate layout"
```

---

## Task 8: Vue island — `advocate-profile`

**Files:**
- Create: [hugo-apps/src/advocate-profile/main.ts](../../../hugo-apps/src/advocate-profile/main.ts)
- Create: [hugo-apps/src/advocate-profile/App.vue](../../../hugo-apps/src/advocate-profile/App.vue)
- Create: [hugo-apps/src/advocate-profile/styles.css](../../../hugo-apps/src/advocate-profile/styles.css)
- Create: [hugo-apps/src/advocate-profile/App.test.ts](../../../hugo-apps/src/advocate-profile/App.test.ts)
- Create: [hugo-apps/src/advocate-profile/App.empty-state.test.ts](../../../hugo-apps/src/advocate-profile/App.empty-state.test.ts)
- Modify: [hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts) — add entry + budget.

- [ ] **Step 1: Write the failing tests**

Create `hugo-apps/src/advocate-profile/App.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/vue';
import App from './App.vue';

describe('advocate-profile App.vue', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders both list sections when both arrays are non-empty', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung',
        authoredTutorials: [{ slug: 'tut-a', title: 'Tutorial A' }],
        contributedTutorials: [{ slug: 'tut-b', title: 'Tutorial B' }],
      }),
    } as any);
    render(App, { props: { apiUrl: '/api/advocates/thomas-jung' } });
    await screen.findByText(/Tutorials authored/i);
    expect(screen.getByText('Tutorial A')).toBeTruthy();
    expect(screen.getByText('Tutorial B')).toBeTruthy();
  });

  it('hides authored section when the array is empty', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        slug: 's', firstName: 'F', lastName: 'L',
        contributedTutorials: [{ slug: 't', title: 'T' }],
      }),
    } as any);
    render(App, { props: { apiUrl: '/api/advocates/s' } });
    await screen.findByText(/Tutorials contributed/i);
    expect(screen.queryByText(/Tutorials authored/i)).toBeNull();
  });
});
```

Create `hugo-apps/src/advocate-profile/App.empty-state.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/vue';
import App from './App.vue';

describe('advocate-profile App.vue 404 path', () => {
  it('renders the "no longer listed" banner on 404', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: false, status: 404, json: async () => ({}),
    } as any);
    render(App, { props: { apiUrl: '/api/advocates/gone' } });
    await screen.findByText(/no longer listed/i);
  });

  it('renders nothing on a generic 5xx error', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    } as any);
    const { container } = render(App, { props: { apiUrl: '/api/advocates/x' } });
    // Banner is what we care about; section headings absent. Allow render to be empty.
    expect(container.querySelector('.adv-profile-island-banner')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npm --prefix hugo-apps test -- src/advocate-profile/
```

Expected: FAIL — files don't exist.

- [ ] **Step 3: Create `App.vue`**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import './styles.css';

interface TutorialLink { slug: string; title: string }
interface SingleAdvocate {
  slug: string;
  firstName: string;
  lastName: string;
  authoredTutorials?: TutorialLink[];
  contributedTutorials?: TutorialLink[];
}

const props = defineProps<{ apiUrl: string }>();
const data = ref<SingleAdvocate | null>(null);
const status = ref<'loading' | 'ok' | 'notFound' | 'error'>('loading');

const authored = computed(() => data.value?.authoredTutorials || []);
const contributed = computed(() => data.value?.contributedTutorials || []);

async function load() {
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' } });
    if (res.status === 404) { status.value = 'notFound'; return; }
    if (!res.ok) { status.value = 'error'; return; }
    data.value = await res.json();
    status.value = 'ok';
  } catch {
    status.value = 'error';
  }
}
load();
</script>

<template>
  <div v-if="status === 'notFound'" class="adv-profile-island-banner" role="status">
    This advocate is no longer listed.
  </div>
  <template v-else-if="status === 'ok'">
    <section v-if="authored.length" class="adv-profile-tutorials" aria-labelledby="adv-prof-authored-h">
      <h2 id="adv-prof-authored-h">Tutorials authored ({{ authored.length }})</h2>
      <ul>
        <li v-for="t in authored" :key="t.slug">
          <a :href="`/tutorials/${t.slug}/`">{{ t.title }}</a>
        </li>
      </ul>
    </section>
    <section v-if="contributed.length" class="adv-profile-tutorials" aria-labelledby="adv-prof-contrib-h">
      <h2 id="adv-prof-contrib-h">Tutorials contributed to ({{ contributed.length }})</h2>
      <ul>
        <li v-for="t in contributed" :key="t.slug">
          <a :href="`/tutorials/${t.slug}/`">{{ t.title }}</a>
        </li>
      </ul>
    </section>
  </template>
</template>
```

- [ ] **Step 4: Create `main.ts`**

```typescript
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('advocate-profile-mount');
if (mount) {
  const apiUrl = mount.getAttribute('data-api') || '';
  if (apiUrl) {
    createApp(App, { apiUrl }).mount(mount);
  }
}
```

- [ ] **Step 5: Create `styles.css`**

```css
.adv-profile {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
  font-family: var(--ds-font-family, system-ui, sans-serif);
}
.adv-profile-back {
  display: inline-block;
  margin-bottom: 16px;
  color: var(--ds-link, #0a6ed1);
  text-decoration: none;
}
.adv-profile-back:hover { text-decoration: underline; }
.adv-profile-hero {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 24px;
  padding: 24px;
  border-radius: 16px;
  background: linear-gradient(135deg, #f1f4f9, #e6effa);
  margin-bottom: 24px;
}
.adv-profile-hero[data-region="AMERICAS"] { background: linear-gradient(135deg, #fef3e7, #fde4c6); }
.adv-profile-hero[data-region="EMEA"]     { background: linear-gradient(135deg, #e8f3ff, #c8e0ff); }
.adv-profile-hero[data-region="APJ"]      { background: linear-gradient(135deg, #e9f7ee, #c7eed4); }
.adv-profile-photo,
.adv-profile-photo-fallback {
  width: 200px; height: 200px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: #cfd8e3; color: white; font-size: 56px; font-weight: 700;
  object-fit: cover;
}
.adv-profile-id h1 { margin: 0 0 8px; font-size: 28px; }
.adv-profile-id .adv-pron { font-size: 16px; color: var(--ds-muted, #556070); font-weight: 400; }
.adv-profile-id .adv-role { font-size: 18px; margin-bottom: 4px; }
.adv-profile-id .adv-loc { color: var(--ds-muted, #556070); margin-bottom: 12px; }
.adv-profile-links { list-style: none; padding: 0; margin: 0; display: flex; gap: 12px; flex-wrap: wrap; }
.adv-profile-links a {
  display: inline-block; padding: 6px 12px; border-radius: 999px;
  background: rgba(255,255,255,0.6); color: #1d2229; text-decoration: none;
  font-size: 14px;
}
.adv-profile-bio { margin-bottom: 24px; }
.adv-profile-bio h2,
.adv-profile-topics h2,
.adv-profile-tutorials h2 { font-size: 20px; margin: 16px 0 8px; }
.adv-bio-md p { line-height: 1.6; margin: 0 0 10px; }
.adv-profile-topics ul,
.adv-profile-tutorials ul { list-style: none; padding: 0; margin: 0; }
.adv-profile-topics li { display: inline-block; margin: 0 8px 8px 0; }
.adv-chip {
  display: inline-block; padding: 4px 10px; border-radius: 999px;
  background: #eef2f7; color: #1d2229; text-decoration: none; font-size: 13px;
}
.adv-chip:hover { background: #dfe6ef; }
.adv-profile-tutorials li { padding: 6px 0; border-bottom: 1px solid #eef2f7; }
.adv-profile-tutorials a { color: var(--ds-link, #0a6ed1); text-decoration: none; }
.adv-profile-tutorials a:hover { text-decoration: underline; }
.adv-profile-island-banner {
  padding: 12px 16px; border-radius: 8px;
  background: #fff5e6; color: #6c4a0f; margin: 16px 0;
}
@media (max-width: 720px) {
  .adv-profile-hero { grid-template-columns: 1fr; text-align: center; }
  .adv-profile-photo, .adv-profile-photo-fallback { margin: 0 auto; }
}
```

- [ ] **Step 6: Add Vite entry + budget**

In `hugo-apps/vite.config.ts`:

1. Above `MAX_ADVOCATES_GZIP`, add:

```typescript
const MAX_ADVOCATE_PROFILE_GZIP = 25 * 1024;
```

2. After `advocatesBudget()` (around line ~85), add:

```typescript
function advocateProfileBudget() {
  return {
    name: 'advocate-profile-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['advocate-profile.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_ADVOCATE_PROFILE_GZIP) {
        // @ts-ignore
        this.error(`advocate-profile.js is ${gz} bytes gzipped (> ${MAX_ADVOCATE_PROFILE_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`advocate-profile.js: ${gz} bytes gzipped (budget ${MAX_ADVOCATE_PROFILE_GZIP}).`);
      }
    }
  };
}
```

3. In the plugins array (around line 142), append `advocateProfileBudget()`:

```typescript
plugins: [vue(), cssInjectedByJsPlugin({ relativeCSSInjection: true }), tutorialPrefsBudget(), codeCheckBudget(), validationBudget(), tutorialBranchesBudget(), advocatesBudget(), advocateProfileBudget(), relatedGraphBudget(), alertsBudget()],
```

4. In `rollupOptions.input`, after the `advocates: resolve(...)` line, add:

```typescript
'advocate-profile': resolve(__dirname, 'src/advocate-profile/main.ts'),
```

- [ ] **Step 7: Run unit tests**

```bash
npm --prefix hugo-apps test -- src/advocate-profile/
```

Expected: PASS (4 tests across both files).

- [ ] **Step 8: Build the island to confirm bundle compiles + stays under budget**

```bash
npm run build:apps
ls hugo/static/js/advocate-profile.js
```

Expected: file exists; Vite stdout shows `advocate-profile.js: <N> bytes gzipped (budget 25600)`. If the bytes exceed budget, Vite would error — diagnose by inspecting the bundle.

- [ ] **Step 9: Run `postbuild:apps` collision check**

```bash
npm run postbuild:apps
```

Expected: PASS (no Hugo `js.Build` output named `advocate-profile.js`).

- [ ] **Step 10: Commit**

```bash
git add hugo-apps/src/advocate-profile/ hugo-apps/vite.config.ts
git commit -m "feat(#601): advocate-profile Vue island + bundle budget"
```

---

## Task 9: Repoint the existing card's "View profile →" link

**Files:**
- Modify: [hugo-apps/src/advocates/components/AdvocateCard.vue](../../../hugo-apps/src/advocates/components/AdvocateCard.vue)

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/advocates/AdvocateCard.profile-link.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/vue';
import AdvocateCard from './components/AdvocateCard.vue';

const baseAdvocate = {
  ID: 'A1', slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung',
  region: 'AMERICAS', hasPhoto: false, topics: [],
  links: [
    { kind: 'LinkedIn', url: 'https://linkedin.com/in/tj', label: null, sortOrder: 100 },
    { kind: 'GitHub', url: 'https://github.com/tj', label: null, sortOrder: 100 },
  ],
};

describe('AdvocateCard "View profile" target', () => {
  it('points at /developer-advocates/<slug>/ (internal)', () => {
    render(AdvocateCard, { props: { advocate: baseAdvocate, photoBase: '/api/advocates' } });
    const link = screen.getByText(/View profile/i).closest('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/developer-advocates/thomas-jung/');
    // No new-tab open since it's an in-site link.
    expect(link?.getAttribute('target')).not.toBe('_blank');
  });
});
```

- [ ] **Step 2: Run it to verify failure**

```bash
npm --prefix hugo-apps test -- src/advocates/AdvocateCard.profile-link.test.ts
```

Expected: FAIL — current `profileUrl` returns an external URL (first matching link).

- [ ] **Step 3: Patch `AdvocateCard.vue`**

Replace the `profileUrl` computed (lines 16-23):

```javascript
// Before
const profileUrl = computed(() => {
  const order = ['Blog','SapCommunity','LinkedIn','GitHub','X','BlueSky','Mastodon','YouTube','Email'];
  for (const k of order) {
    const link = props.advocate.links.find(l => l.kind === k);
    if (link) return link.url;
  }
  return null;
});

// After
const profileUrl = computed(() => `/developer-advocates/${props.advocate.slug}/`);
```

Also remove `target="_blank"` and `rel="noopener"` from the "View profile →" `<a>` in the template (line ~103):

```html
<!-- Before -->
<a v-if="profileUrl" class="adv-profile" :href="profileUrl" target="_blank" rel="noopener">
  View profile →
</a>

<!-- After -->
<a v-if="profileUrl" class="adv-profile" :href="profileUrl">
  View profile →
</a>
```

- [ ] **Step 4: Run the new test and existing AdvocateCard suite**

```bash
npm --prefix hugo-apps test -- src/advocates/
```

Expected: All previously-passing tests still pass; new test passes.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/advocates/components/AdvocateCard.vue hugo-apps/src/advocates/AdvocateCard.profile-link.test.ts
git commit -m "feat(#601): card 'View profile →' navigates to internal /developer-advocates/<slug>/"
```

---

## Task 10: Smoke tests — deployed profile page + endpoint

**Files:**
- Modify: [test/smoke/advocates.smoke.test.js](../../../test/smoke/advocates.smoke.test.js)

- [ ] **Step 1: Add three new assertions**

Append to `test/smoke/advocates.smoke.test.js` (existing file). After the `__JOULE_ADVOCATES` describe block:

```javascript
describe.skipIf(!BASE || !SRV)('GET /developer-advocates/:slug/ profile page', () => {
  it('returns 200 + og:title + og:image (when an advocate has a photo)', async () => {
    // Pick the first advocate from the live API.
    const list = await fetch(SRV + '/api/advocates').then(r => r.json());
    const photo = (list.advocates || []).find(a => a.hasPhoto);
    if (!photo) { console.log('No advocate with hasPhoto:true; skipping og:image assertion'); return; }
    const res = await fetch(BASE + '/developer-advocates/' + photo.slug + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+property=["']?og:title["']?/);
    expect(html).toMatch(/<meta[^>]+property=["']?og:type["']?[^>]*content=["']?profile["']?/);
    expect(html).toMatch(/<meta[^>]+property=["']?og:image["']?/);
  });
});

describe.skipIf(!SRV)('GET /api/advocates/:slug', () => {
  it('returns 200 + correct shape for a known slug', async () => {
    const list = await fetch(SRV + '/api/advocates').then(r => r.json());
    const first = list.advocates?.[0];
    if (!first) return; // empty roster → skip
    const res = await fetch(SRV + '/api/advocates/' + first.slug);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(first.slug);
    expect(body).toHaveProperty('topics');
    expect(body).toHaveProperty('links');
    expect(body).not.toHaveProperty('advocates');
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await fetch(SRV + '/api/advocates/__does-not-exist__601');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run smoke tests locally with the deployed URLs (if available)**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npm run test:smoke -- test/smoke/advocates.smoke.test.js
```

Expected: PASS for the slug + 404 cases. The og:image assertion only runs if a deployed advocate has a photo AND a page has been built — may need to wait until Task 11 (deploy) lands. Until then it logs and skips.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/advocates.smoke.test.js
git commit -m "test(#601): smoke coverage for profile page + /api/advocates/:slug"
```

---

## Task 11: Document the new page + endpoint

**Files:**
- Modify: [docs/developers/architecture/advocates.md](../../developers/architecture/advocates.md)

- [ ] **Step 1: Append a `## Per-advocate profile pages` section**

Add to `docs/developers/architecture/advocates.md` after the `## Public API` section:

```markdown
## Per-advocate profile pages

Spec: [2026-06-27 per-advocate-profile design](../../superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md).
Issue: [#601](https://github.com/sap-tutorials/tutorials-ims/issues/601).

Each active advocate has a stable, sharable URL of the form
`/developer-advocates/<slug>/`.

- **Build step:** [scripts/fetch-advocates.ts](../../../scripts/fetch-advocates.ts)
  pulls `GET /api/advocates` at build time, renders each `bio` via
  `markdown-it` and sanitizes via `sanitize-html`, and emits one
  `.md` per active advocate into `hugo/content/developer-advocates/`.
  Chained into `npm run fetch-tutorials` so `build:all` and
  `rebuild-content.yml` invoke it automatically. Per-slug `.md` files
  are gitignored — only `_index.md` is tracked.
- **Page rendering:**
  [hugo/layouts/developer-advocates/single.html](../../../hugo/layouts/developer-advocates/single.html)
  server-renders the hero (photo, name, social links), bio (HTML
  from markdown), and topic chips. The chips link to
  `/developer-advocates/#topic=<slug>` so the existing directory
  filter composable picks up the selection on initial mount.
- **Hydration:**
  [hugo-apps/src/advocate-profile/](../../../hugo-apps/src/advocate-profile/)
  is a Vue 3 island bundled at `hugo/static/js/advocate-profile.js`
  (≤ 25 KB gzip, enforced by `advocateProfileBudget()` in
  [hugo-apps/vite.config.ts](../../../hugo-apps/vite.config.ts)).
  Fetches `GET /api/advocates/<slug>` and renders the
  "Tutorials authored" + "Tutorials contributed to" sections. On
  404 (advocate deactivated since the last rebuild) shows a small
  "no longer listed" banner.
- **Single-advocate endpoint:** `GET /api/advocates/:slug` returns
  the same row shape as a list item from `/api/advocates` but as a
  single object. 404 on unknown slug or `isActive:false`. ETag +
  `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
- **Card → page link:** the existing roster card's "View profile →"
  button (`AdvocateCard.vue`) navigates to `/developer-advocates/<slug>/`.
  External profile icons stay on the card itself.
- **Out of scope for v1** (see spec Non-goals): authored missions /
  groups / events (no `author` association in their schema today),
  RSS feeds, embedded media in bios.
```

- [ ] **Step 2: Sidebar guard**

```bash
npm run predocs:build
```

Expected: PASS (no unregistered pages / dead links — `architecture/advocates.md` was already registered).

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/advocates.md
git commit -m "docs(#601): document per-advocate profile pages"
```

---

## Task 12: Full local build verification

**Files:** (no edits — verification only)

- [ ] **Step 1: Run `build:all` against local CAP**

```bash
# In one terminal:
cds watch
# In this terminal:
CAP_BASE_URL=http://localhost:4004 npm run build:all
```

Expected: completes without errors. `hugo/public/developer-advocates/` now contains an `index.html` for the directory and one `<slug>/index.html` per active advocate.

- [ ] **Step 2: Inspect a sample profile page**

```bash
ls hugo/public/developer-advocates/
# Pick a slug from the listing:
grep -i "og:" hugo/public/developer-advocates/<slug>/index.html | head -10
grep "advocate-profile-mount" hugo/public/developer-advocates/<slug>/index.html
grep "advocate-profile.js" hugo/public/developer-advocates/<slug>/index.html
```

Expected: og:title / og:type / og:description meta tags present; the mount div with `data-api="/api/advocates/<slug>"` is present; the script tag references `/js/advocate-profile.js`.

- [ ] **Step 3: Run the full unit suite**

```bash
npm test
```

Expected: PASS, including all new tests.

- [ ] **Step 4: Commit-stamp marker (no file changes)**

Skip — only step needed if `build:all` regenerated tracked files. The `hugo/content/developer-advocates/*.md` files are gitignored. `hugo/public/` is also gitignored.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin worktree-601-advocate-profile-pages
gh pr create --title "feat(#601): per-advocate profile pages" \
  --body "$(cat <<'EOF'
Closes #601.

Per-advocate profile pages at /developer-advocates/<slug>/. Hybrid
Hugo + Vue island: build-time fetcher emits a static page per
active advocate (hero, bio, social links, topic chips), island
hydrates the tutorial lists from a new GET /api/advocates/:slug.

Spec: docs/superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md

Out of scope for v1 (see spec Non-goals): authored missions/groups
(would require schema migration), events, RSS feeds.

## Verification

- [x] Unit tests: \`npm test\` PASS
- [x] Bundle budget: advocate-profile.js stays ≤ 25 KB gzip
- [ ] Hybrid: \`ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/advocate-profile-route.test.js\`
- [ ] Smoke (post-deploy): three new assertions in advocates.smoke.test.js
- [ ] Manual: visit /developer-advocates/<known-slug>/ after \`build:all\`
EOF
)"
```

---

## Acceptance checklist (mirror of spec §Acceptance criteria)

After all tasks land and the PR deploys to DEV:

- [ ] `GET /developer-advocates/<slug>/` returns 200 HTML with `<title>`, `og:title`, `og:description`, `og:image` (when `hasPhoto`), `og:type=profile` meta tags.
- [ ] The page hero shows photo (or initials), name, pronouns, title, location, region, social-link icons — all in static HTML.
- [ ] The bio renders as HTML (formatted markdown). Plain-text bios still display correctly.
- [ ] After hydration, the page lists tutorials authored and tutorials contributed to, each linked to `/tutorials/<slug>/`.
- [ ] `GET /api/advocates/<slug>` returns `Cache-Control: public, max-age=60, stale-while-revalidate=600` and a valid `ETag`; a follow-up request with `If-None-Match: <etag>` returns 304.
- [ ] The existing roster grid card's "View profile →" button navigates to the internal page.
- [ ] Topic chips on the profile page link back to the directory page with that topic pre-filtered (via `#topic=<slug>`).
- [ ] `GET /api/advocates/__does-not-exist__` returns 404.
- [ ] Deactivating an advocate hides their profile page on next `rebuild-content` run; visiting the stale URL between deactivation and rebuild shows the island's "no longer listed" banner.
- [ ] Bundle for `advocate-profile.js` is ≤ 25 KB gzip; budget check is enforced at build time.
- [ ] Unit, hybrid, and smoke tests all green.

---

## Notes for the implementer

- **TDD throughout.** Each task's Step 1 writes the failing test first. Don't skip the FAIL → PASS confirmation — it catches false positives.
- **Single concept per commit.** If a step balloons (e.g. you find the Hugo `baseof.html` doesn't have a `head_extra` hook), commit the existing work, open a follow-up sub-task, then continue.
- **The og:image absolute URL is derived from `.Site.BaseURL`** in the Hugo template (Task 7 Step 3). If `hugo.toml` / `hugo.qa.toml` don't have correct `baseURL` set per environment, the meta tag URL will be wrong on DEV/QA — open a follow-up issue rather than hardcoding hostnames into the layout.
- **markdown-it auto-link.** The renderer is initialized with `linkify: true`, so bare URLs in plain-text bios become anchors. `breaks: false` matches CommonMark; if advocates rely on single-newline-as-`<br>` behavior, flip to `breaks: true` (test cases would need updates).
- **YAML emitter:** Task 5 uses `yaml@^2.7.0` via `import { stringify as yamlStringify } from 'yaml'` — same package
  [scripts/parsers/render-frontmatter.ts](../../../scripts/parsers/render-frontmatter.ts) uses for tutorial pages.
  It handles quoting, escaping, multi-line strings, and Unicode automatically. No hand-rolled
  YAML.
