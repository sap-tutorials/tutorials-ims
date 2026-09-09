# sm_tech_ids Meta-Tag Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `<meta name="sm_tech_ids">` tag carrying Semaphore/PPMS product IDs on tutorial, mission, group, and topic-detail pages so the site-search crawler can filter migrated documents.

**Architecture:** One shared resolution module (`srv/lib/semaphore-tags.js`) exposes the tag→ID map and the format string. Two emission paths consume it: build-time (a new `/build/tag-semaphore` feed → `fetch-tutorials.ts` → frontmatter → Hugo `head-meta.html`) for tutorials, and runtime SSR (`composeShell` insertion, opt-in via `meta.smTechIds`) for missions/groups/topic-detail. Every path fails open — missing data yields no tag, never a broken page.

**Tech Stack:** SAP CAP (Node.js, CDS QL over HANA/SQLite), TypeScript build scripts (`scripts/`), Hugo Go templates, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-sm-tech-ids-restoration-design.md`

## Global Constraints

- **Emit format:** `content="en-US,<id>,<id>,…"` — literal locale `en-US` first, then product semaphore IDs, comma-separated, **no spaces**. Empty ID list → **no meta tag emitted**.
- **Which IDs:** only product tags — `Tags.isActualTag = true` AND `Tags.semaphoreId` non-null. Non-product / null-semaphore tags excluded.
- **Which pages:** tutorials, missions, groups, topic **detail** (`/topics/<slug>/`). **Excluded:** `/browse/`, verb lanes, sitemaps, homepage, topics **index** `/topics/`, concepts, puzzles, channels.
- **Join key (build path only):** frontmatter tag slugs are **mdFormat**; `Tags.titlePath` is human form. Bridge with `titlePathToMdFormat(titlePath)` (`srv/lib/tag-md-format.js`) — the exact transform `/build/tags` already uses. Duplicate mdFormat keys: last-write-wins.
- **Fail open everywhere:** any resolution/fetch error → empty map/list → no meta tag; never throw into serve/render/publish/build.
- **No schema change, no migration, no env flag** — always-on emission of already-migrated data.
- **No raw SQL** except via `db.run()` in the established `/build/*` style (raw entity-name `SELECT.from('com.sap.developers.ims.Tags')`); use CDS QL / CQL otherwise.
- **`.deploy/mta.yaml` srv-qa cp-list:** `srv/lib/semaphore-tags.js` becomes a transitive `./` import of `content-store.js` (via `chrome-shell.js`) — it MUST be added to the `srv-qa` `cp` list or QA boot crashes at deploy time.

---

### Task 1: `srv/lib/semaphore-tags.js` — shared map + formatter

**Files:**
- Create: `srv/lib/semaphore-tags.js`
- Test: `srv/__tests__/lib/semaphore-tags.test.js`

**Interfaces:**
- Consumes: `titlePathToMdFormat(titlePath: string) → string` from `srv/lib/tag-md-format.js`.
- Produces:
  - `getSemaphoreMdMap(db) → Promise<Record<string, string>>` — keys are `mdFormat`, values are `semaphoreId` strings; only `isActualTag=true` + non-null `semaphoreId`; last-write-wins on dup mdFormat.
  - `formatSmTechIds(ids: string[], locale = 'en-US') → string` — `''` for empty/nullish; else `` `${locale},${dedupedIds.join(',')}` ``, first-seen order preserved.

- [ ] **Step 1: Write the failing test**

```javascript
// srv/__tests__/lib/semaphore-tags.test.js
import '@sap/cds'; // registers SELECT/CQL globals used by getSemaphoreMdMap
import { describe, it, expect } from 'vitest';
import { getSemaphoreMdMap, formatSmTechIds } from '../../lib/semaphore-tags.js';

// Fake db: ignores the query, returns canned Tags rows.
function fakeDb(rows) {
  return { run: async () => rows };
}

describe('getSemaphoreMdMap', () => {
  it('keys by mdFormat, keeps only non-null semaphoreId', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '7355001', isActualTag: true },
      { titlePath: 'Software Product : Technology Platform / SAP AI Services', semaphoreId: null, isActualTag: true },
    ]));
    expect(map).toEqual({ 'software-product>sap-hana': '7355001' });
  });

  it('last-write-wins on duplicate mdFormat', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '111', isActualTag: true },
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '222', isActualTag: true },
    ]));
    expect(map).toEqual({ 'software-product>sap-hana': '222' });
  });

  it('drops rows whose titlePath yields empty mdFormat', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: '', semaphoreId: '999', isActualTag: true },
    ]));
    expect(map).toEqual({});
  });
});

describe('formatSmTechIds', () => {
  it('prefixes locale, comma-joins, no spaces', () => {
    expect(formatSmTechIds(['111', '222'])).toBe('en-US,111,222');
  });
  it('returns empty string for empty/nullish list', () => {
    expect(formatSmTechIds([])).toBe('');
    expect(formatSmTechIds(undefined)).toBe('');
  });
  it('dedupes preserving first-seen order', () => {
    expect(formatSmTechIds(['111', '222', '111'])).toBe('en-US,111,222');
  });
  it('honours an explicit locale', () => {
    expect(formatSmTechIds(['111'], 'de-DE')).toBe('de-DE,111');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/lib/semaphore-tags.test.js`
Expected: FAIL — `Cannot find module '../../lib/semaphore-tags.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/semaphore-tags.js
//
// Single source of truth for the product-tag → Semaphore-ID mapping used to
// emit <meta name="sm_tech_ids"> tags for the site-search crawler.
//
// - getSemaphoreMdMap(db): build-time map keyed by mdFormat (joins to Hugo
//   frontmatter tag slugs the same way /build/tags does).
// - formatSmTechIds(ids, locale): the exact meta `content` string.
//
// Fail-open: callers treat an empty map / '' as "emit nothing".

import { titlePathToMdFormat } from './tag-md-format.js';

const TAGS = 'com.sap.developers.ims.Tags';

// Product-tag semaphore IDs keyed by mdFormat slug. Mirrors /build/tags:
// raw entity-name SELECT + JS-side titlePathToMdFormat + dedupe. Last-write-
// wins on a duplicate mdFormat (deterministic, matches the /build/tags set).
export async function getSemaphoreMdMap(db) {
  const rows = await db.run(
    SELECT.from(TAGS).columns('titlePath', 'semaphoreId', 'isActualTag').where({ isActualTag: true }),
  );
  const map = {};
  for (const r of rows) {
    if (r.semaphoreId === null || r.semaphoreId === undefined || r.semaphoreId === '') continue;
    const md = titlePathToMdFormat(r.titlePath);
    if (!md) continue;
    map[md] = String(r.semaphoreId);
  }
  return map;
}

// The meta `content` value: locale first, then de-duped IDs (first-seen
// order), comma-joined, no spaces. Empty/nullish list → '' (caller emits
// no tag).
export function formatSmTechIds(ids, locale = 'en-US') {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const s = String(id ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length === 0) return '';
  return `${locale},${out.join(',')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/lib/semaphore-tags.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/semaphore-tags.js srv/__tests__/lib/semaphore-tags.test.js
git commit -m "feat(sm-tech-ids): shared semaphore-tags map + formatter"
```

---

### Task 2: `/build/tag-semaphore` feed in `srv/server.js`

**Files:**
- Modify: `srv/server.js` (add route immediately after the `/build/tags` route, currently ending at `srv/server.js:488`)
- Test: `srv/__tests__/build-tag-semaphore.test.js`

**Interfaces:**
- Consumes: `getSemaphoreMdMap(db)` from Task 1.
- Produces: `GET /build/tag-semaphore` → `200 {"map": {[mdFormat]: semaphoreId}, "buildAt": ISOString}`; `Cache-Control: public, max-age=60`; `500 {"error"}` on failure. Anonymous (registered in the same pre-CDS-auth block as `/build/tags`).

- [ ] **Step 1: Add the import (top of `srv/server.js`, alongside the existing `titlePathToMdFormat` import)**

Find the existing import of `tag-md-format.js` near the top of `srv/server.js` and add, next to it:

```javascript
import { getSemaphoreMdMap } from './lib/semaphore-tags.js';
```

(If `titlePathToMdFormat` is imported via `require`/dynamic form in this file, match that form for the new import.)

- [ ] **Step 2: Write the failing test**

```javascript
// srv/__tests__/build-tag-semaphore.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const { GET } = cds.test(process.cwd()).in(process.cwd());

describe('GET /build/tag-semaphore', () => {
  it('returns a map object and buildAt with a 60s cache header', async () => {
    const res = await GET('/build/tag-semaphore');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('map');
    expect(typeof res.data.map).toBe('object');
    expect(res.data).toHaveProperty('buildAt');
    expect(res.headers['cache-control']).toContain('max-age=60');
  });
});
```

> If the repo's existing `/build/*` tests use a different harness bootstrap (e.g. a shared `test/helpers`), mirror that file's setup instead of `cds.test(process.cwd())` — check `srv/__tests__/` for the closest existing `/build/` route test and copy its top-of-file pattern verbatim.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/build-tag-semaphore.test.js`
Expected: FAIL — `res.status` is 404 (route not registered).

- [ ] **Step 4: Add the route (insert after the `/build/tags` handler, after line 488)**

```javascript
  // sm_tech_ids restoration: product-tag semaphore IDs keyed by the SAME
  // mdFormat slug /build/tags emits, so fetch-tutorials can join them onto
  // frontmatter tag slugs. Public, unauthenticated, 60s cache. Fail-closed
  // with a 500 so a build-time fetch failure falls back to "no meta" (the
  // caller treats a non-200 as an empty map).
  app.get('/build/tag-semaphore', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const map = await getSemaphoreMdMap(db);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ map, buildAt: new Date().toISOString() });
    } catch (err) {
      console.error('[build/tag-semaphore]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/build-tag-semaphore.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js srv/__tests__/build-tag-semaphore.test.js
git commit -m "feat(sm-tech-ids): /build/tag-semaphore feed"
```

---

### Task 3: `render-frontmatter.ts` — `smTechIds` frontmatter field

**Files:**
- Modify: `scripts/parsers/render-frontmatter.ts` (interface at `:9-63`; destructure at `:65-91`; `dedupedRawSlugs` at `:96`; `fm` object at `:98-135`)
- Test: `scripts/__tests__/render-frontmatter-smtechids.test.ts`

**Interfaces:**
- Consumes: nothing new (map is passed in as an arg).
- Produces: `RenderHugoFrontmatterArgs` gains optional `semaphoreMap?: Record<string, string>`. When provided, `renderHugoFrontmatter` emits a top-level frontmatter key `smTechIds: string[]` computed from `dedupedRawSlugs` (the deduped primary+tags slug list already in mdFormat) mapped through `semaphoreMap`; the key is **omitted** when the resulting list is empty.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/__tests__/render-frontmatter-smtechids.test.ts
import { describe, it, expect } from 'vitest'
import { renderHugoFrontmatter } from '../parsers/render-frontmatter.js'

const base = {
  slug: 't', title: 'T', description: 'd', time: 10, level: 'beginner',
  author: 'A', authorProfile: 'p', youWillLearn: [], prerequisites: '',
  steps: [], nav: { prev: null, next: null }, lastUpdated: '', createdAt: '',
  contributors: [],
}

describe('renderHugoFrontmatter smTechIds', () => {
  it('emits smTechIds for tags that hit the semaphore map', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['software-product>sap-hana'],
      primaryTag: 'software-product>sap-hana',
      semaphoreMap: { 'software-product>sap-hana': '7355001' },
    })
    expect(out).toContain('smTechIds:')
    expect(out).toContain('7355001')
  })

  it('omits the smTechIds key entirely when no tag matches', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['topic>something'],
      primaryTag: 'topic>something',
      semaphoreMap: { 'software-product>sap-hana': '7355001' },
    })
    expect(out).not.toContain('smTechIds')
  })

  it('omits smTechIds when no map is passed', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['software-product>sap-hana'],
      primaryTag: 'software-product>sap-hana',
    })
    expect(out).not.toContain('smTechIds')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/render-frontmatter-smtechids.test.ts`
Expected: FAIL — first case: `smTechIds:` not found.

- [ ] **Step 3: Add `semaphoreMap` to the interface**

In `RenderHugoFrontmatterArgs` (after the `registry?: TagLabelRegistry` line at `:26`), add:

```typescript
  /**
   * sm_tech_ids restoration: mdFormat-slug → Semaphore product ID. When
   * present, emits a top-level `smTechIds: string[]` frontmatter key from the
   * page's deduped tag slugs. Absent/empty → key omitted (fail-open).
   */
  semaphoreMap?: Record<string, string>
```

- [ ] **Step 4: Destructure it and compute the field**

In the destructure block (`:66-91`), add `semaphoreMap` to the list (e.g. after `video,`).

Immediately after the `fm` object literal closes (after `:135`, before the `if (nav.missionId)` block at `:137`), add:

```typescript
  // sm_tech_ids restoration: product-tag semaphore IDs for this page's tags,
  // in mdFormat. Reuse dedupedRawSlugs (already deduped, already mdFormat).
  // Omit the key when nothing matches so non-product pages carry no stray field.
  if (semaphoreMap) {
    const smTechIds = dedupedRawSlugs.map(s => semaphoreMap[s]).filter(Boolean)
    if (smTechIds.length > 0) fm.smTechIds = smTechIds
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/render-frontmatter-smtechids.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Run the existing frontmatter suite for regressions**

Run: `npx vitest run scripts/__tests__/hugo-write.test.ts`
Expected: PASS — the new key is additive and gated on `semaphoreMap`.

- [ ] **Step 7: Commit**

```bash
git add scripts/parsers/render-frontmatter.ts scripts/__tests__/render-frontmatter-smtechids.test.ts
git commit -m "feat(sm-tech-ids): smTechIds frontmatter field in render-frontmatter"
```

---

### Task 4: `fetch-tutorials.ts` — fetch the map + thread it into `writeHugoPage`

**Files:**
- Modify: `scripts/fetch-tutorials.ts` — add `fetchSemaphoreMap()` (near `fetchTagLabelRegistry` at `:623-639`); extend `writeHugoPage` signature (`:493-516`) + its `renderHugoFrontmatter` call (`:517-539`); fetch the map once (near `:844`); pass it at the call site (`:1120-1143`); fold it into the decision fingerprint (`:865`).
- Test: covered end-to-end by the hybrid/smoke tasks (Task 8); no standalone unit test — this task is pure wiring of already-tested units.

**Interfaces:**
- Consumes: `renderHugoFrontmatter`'s new `semaphoreMap` arg (Task 3); `/build/tag-semaphore` feed (Task 2).
- Produces: `fetchSemaphoreMap() → Promise<Record<string,string>>` (empty on any error). `writeHugoPage` gains a trailing optional positional param `semaphoreMap: Record<string, string> = {}`.

- [ ] **Step 1: Add `fetchSemaphoreMap()` (after `fetchTagLabelRegistry` at `:639`)**

```typescript
async function fetchSemaphoreMap(): Promise<Record<string, string>> {
  const capBaseUrl = process.env.CAP_BASE_URL ?? 'http://localhost:4004'
  const url = `${capBaseUrl}/build/tag-semaphore`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[tag-semaphore] ${url} returned ${res.status} — no sm_tech_ids will be emitted`)
      return {}
    }
    const body = await res.json() as { map?: Record<string, string> }
    const map = body.map ?? {}
    console.log(`[tag-semaphore] loaded ${Object.keys(map).length} (mdFormat, semaphoreId) pairs from ${url}`)
    return map
  } catch (e) {
    console.warn(`[tag-semaphore] fetch failed (${(e as Error).message}) — no sm_tech_ids will be emitted`)
    return {}
  }
}
```

- [ ] **Step 2: Extend `writeHugoPage`'s signature and forward the arg**

In the parameter list (`:493-516`), add a trailing optional positional param after `video` (`:515`):

```typescript
  video: import('./parsers/types.js').NormalizedVideo | null = null,
  semaphoreMap: Record<string, string> = {},
): void {
```

In the `renderHugoFrontmatter({ … })` call (`:517-539`), add `semaphoreMap` to the object (after `video,` at `:538`):

```typescript
    video,
    semaphoreMap,
  })
```

- [ ] **Step 3: Fetch the map once, alongside the tag registry (`:844`)**

Immediately after `const tagRegistry = await fetchTagLabelRegistry()` (`:844`), add:

```typescript
  // sm_tech_ids restoration: product-tag semaphore IDs for frontmatter emit.
  // Empty on failure → no sm_tech_ids meta (fail-open).
  const semaphoreMap = await fetchSemaphoreMap()
```

- [ ] **Step 4: Fold the map into the content-cache decision fingerprint (`:865`)**

The fast-path fingerprint must bust when semaphore data changes, else a slug-targeted run would reuse cached pages with stale/absent `sm_tech_ids`. Change (`:865`):

```typescript
  const decisionFingerprint = computeFeedFingerprint({ catalog: loadCapCache(), tagLabels: tagRegistry, semaphore: semaphoreMap })
```

> Check `computeFeedFingerprint`'s implementation: if it stringifies its whole argument object (common), no signature change is needed — the new key participates automatically. If it destructures specific keys, add `semaphore` to that destructure and include it in the hashed payload. Grep `computeFeedFingerprint` in `scripts/` and confirm before editing.

- [ ] **Step 5: Pass `semaphoreMap` at the `writeHugoPage` call site (`:1120-1143`)**

Add `semaphoreMap` as the final argument after `normalizeVideo(...)` (`:1142`):

```typescript
          normalizeVideo(frontmatter.video, t.slug),
          semaphoreMap,
        )
```

- [ ] **Step 6: Type-check + run the fetch-tutorials-adjacent suites**

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's script — check `jq '.scripts' package.json` for `typecheck`/`build:check`)
Run: `npx vitest run scripts/__tests__/hugo-write.test.ts`
Expected: both PASS. `hugo-write.test.ts` calls `writeHugoPage` without the new arg → defaults to `{}` → no `sm_tech_ids`, existing assertions unaffected.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(sm-tech-ids): fetch semaphore map + thread into writeHugoPage"
```

---

### Task 5: Hugo emit in `head-meta.html`

**Files:**
- Modify: `hugo/layouts/partials/head-meta.html` (after the `keywords` block at `:15-17`)
- Test: manual render assertion folded into the smoke task (Task 8); no Hugo unit-test harness exists in this repo for partials.

**Interfaces:**
- Consumes: `.Params.smTechIds` (string slice from frontmatter, Task 3).
- Produces: `<meta name="sm_tech_ids" content="en-US,…">` on pages that carry the param; nothing otherwise.

- [ ] **Step 1: Add the emit (after line 17, before the blank line preceding the `author` block)**

```go-html-template
{{- with .Params.smTechIds }}
<meta name="sm_tech_ids" content="en-US,{{ delimit . "," }}">
{{- end }}
```

> `with` skips emission when the slice is absent/empty. `head.html` passes the full `Page` to this partial, so it reaches every page type — but only tutorials populate `smTechIds`, so only they emit it. The locale prefix is literal here to match `formatSmTechIds`'s `en-US` default used on the SSR path.

- [ ] **Step 2: Verify against a built page**

After a local build with `smTechIds` in a tutorial's frontmatter (or via the Task 8 smoke run), grep the built HTML:

Run: `grep -o 'name="sm_tech_ids" content="[^"]*"' hugo/public/tutorials/<known-slug>/index.html`
Expected: one line, `en-US,`-prefixed. A tutorial with no product tag emits nothing.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/head-meta.html
git commit -m "feat(sm-tech-ids): emit sm_tech_ids meta in Hugo head-meta"
```

---

### Task 6: `composeShell` insertion (SSR emit) + srv-qa cp-list

**Files:**
- Modify: `srv/lib/chrome-shell.js` (add import at top near `:16-19`; insert emit inside `composeShell`, after the description-meta rewrite / before `return` at `:251`)
- Modify: `.deploy/mta.yaml` (srv-qa cp list, line 181 — add `../../srv/lib/semaphore-tags.js`)
- Test: `srv/__tests__/lib/chrome-shell-smtechids.test.js`

**Interfaces:**
- Consumes: `formatSmTechIds` from Task 1; `meta.smTechIds?: string[]` (populated by Tasks 7 & the topic/catalog tasks).
- Produces: `composeShell(halves, bodyHtml, meta)` inserts exactly one `<meta name="sm_tech_ids" content="…">` immediately after the rewritten `<meta name="description">` when `meta.smTechIds` is a non-empty array; idempotent (strips any pre-existing one first); no-op when absent/empty.

- [ ] **Step 1: Write the failing test**

```javascript
// srv/__tests__/lib/chrome-shell-smtechids.test.js
import { describe, it, expect } from 'vitest';
import { composeShell } from '../../lib/chrome-shell.js';

const halves = {
  before: '<head><meta name="description" content="x"></head>',
  after: '</body>',
};

describe('composeShell sm_tech_ids', () => {
  it('inserts one meta after the description meta when smTechIds present', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x',
      smTechIds: ['111', '222'],
    });
    expect(out).toContain('<meta name="sm_tech_ids" content="en-US,111,222">');
    // exactly one occurrence
    expect(out.match(/name="sm_tech_ids"/g)).toHaveLength(1);
  });

  it('emits nothing when smTechIds is absent', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x',
    });
    expect(out).not.toContain('sm_tech_ids');
  });

  it('emits nothing when smTechIds is empty', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: [],
    });
    expect(out).not.toContain('sm_tech_ids');
  });

  it('is idempotent — re-composing does not duplicate the tag', () => {
    const once = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: ['111'],
    });
    const twice = composeShell({ before: once.replace('<main></main></body>', ''), after: '</body>' }, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: ['111'],
    });
    expect(twice.match(/name="sm_tech_ids"/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/lib/chrome-shell-smtechids.test.js`
Expected: FAIL — first case: tag not found.

- [ ] **Step 3: Add the import (in the import block at the top of `chrome-shell.js`, `:16-19`)**

```javascript
import { formatSmTechIds } from './semaphore-tags.js';
```

- [ ] **Step 4: Insert the emit in `composeShell` (just before `return \`${patchedBefore}${bodyHtml}${after}\`;` at `:251`)**

```javascript
  // sm_tech_ids restoration: opt-in per caller (meta.smTechIds). Insert one
  // meta immediately after the (already-rewritten) description meta so the
  // crawler finds it in <head>. Idempotent: strip any pre-existing tag first
  // (defensive against re-compose). No-op when the caller doesn't opt in.
  if (Array.isArray(meta.smTechIds) && meta.smTechIds.length) {
    const smContent = escapeAttr(formatSmTechIds(meta.smTechIds));
    if (smContent) {
      patchedBefore = patchedBefore
        .replace(/<meta name="sm_tech_ids" content="[^"]*">/g, '')
        .replace(
          /<meta name="description" content="[^"]*">/,
          (m) => `${m}<meta name="sm_tech_ids" content="${smContent}">`,
        );
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/lib/chrome-shell-smtechids.test.js`
Expected: PASS (all four cases).

- [ ] **Step 6: Run the existing chrome-shell suite for regressions**

Run: `npx vitest run srv/__tests__/lib/ -t chrome` (or the existing chrome-shell test file — grep `srv/__tests__` for `composeShell`)
Expected: PASS — insertion is gated on `meta.smTechIds`; all current callers pass no such key yet.

- [ ] **Step 7: Add `semaphore-tags.js` to the srv-qa cp list**

In `.deploy/mta.yaml` line 181, inside the big `cp` command, find `../../srv/lib/tag-md-format.js` and add `../../srv/lib/semaphore-tags.js` adjacent to it (same space-separated list, before the trailing `srv/lib/` target):

```
… ../../srv/lib/topic-slug.js ../../srv/lib/tag-md-format.js ../../srv/lib/semaphore-tags.js ../../srv/lib/publish-channels.js …
```

> Rationale: `chrome-shell.js` (already in the list) now `import`s `semaphore-tags.js`, making it a transitive `./` dep of `content-store.js`. A missing transitive dep crashes `srv-qa` boot at MTA deploy time.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/chrome-shell.js srv/__tests__/lib/chrome-shell-smtechids.test.js .deploy/mta.yaml
git commit -m "feat(sm-tech-ids): composeShell inserts sm_tech_ids; add lib to srv-qa cp list"
```

---

### Task 7: Mission/group SSR — resolve product tags → `smTechIds`

**Files:**
- Modify: `srv/lib/catalog-data.js` (`loadGroupContext` at `:75-116`, `loadMissionContext` at `:124+`; add a shared `resolveSmTechIds` helper)
- Modify: `srv/lib/catalog-renderer.js` (`renderCatalogPage` pageMeta blocks at `:262-272` group, `:279-289` mission)
- Test: `srv/__tests__/lib/catalog-data-smtechids.test.js`

**Interfaces:**
- Consumes: `GroupTags`/`MissionTags`/`Tags` entities via `cds.entities(NAMESPACE)`.
- Produces: `loadGroupContext` / `loadMissionContext` return objects gain `smTechIds: string[]` (the group/mission's product-tag semaphore IDs, read directly from `Tags.semaphoreId` — no mdFormat round-trip on the SSR path). `renderCatalogPage` copies `ctx.smTechIds` into `pageMeta.smTechIds`.

- [ ] **Step 1: Write the failing test**

```javascript
// srv/__tests__/lib/catalog-data-smtechids.test.js
import '@sap/cds';
import { describe, it, expect } from 'vitest';
import { resolveSmTechIds } from '../../lib/catalog-data.js';

// resolveSmTechIds(db, joinEntity, ownerCol, ownerId): reads <joinEntity>
// rows for ownerId, joins tag_ID → Tags, returns product-tag semaphoreIds.
function fakeDb({ links, tags }) {
  return {
    run: async (q) => {
      const s = String(q); // heuristic: which table the query targets
      if (/GROUPTAGS|MISSIONTAGS|GroupTags|MissionTags/i.test(s)) return links;
      return tags;
    },
  };
}

describe('resolveSmTechIds', () => {
  it('returns semaphoreIds of the owner\'s product tags', async () => {
    const db = fakeDb({
      links: [{ tag_ID: 't1' }, { tag_ID: 't2' }],
      tags: [
        { ID: 't1', semaphoreId: '111', isActualTag: true },
        { ID: 't2', semaphoreId: null, isActualTag: true },
      ],
    });
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g1');
    expect(ids).toEqual(['111']);
  });

  it('returns [] and never throws on a DB error', async () => {
    const db = { run: async () => { throw new Error('boom'); } };
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g1');
    expect(ids).toEqual([]);
  });
});
```

> The `fakeDb` string-matching is a stand-in; if `SELECT`'s stringified form doesn't expose the entity name reliably in this CDS version, split the two reads so the helper accepts injectable readers, or convert this to a hybrid-only assertion (Task 8) and keep the unit test on the pure filtering logic. Confirm `String(SELECT.from(GroupTags))` output during Step 2 and adjust the fake accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/lib/catalog-data-smtechids.test.js`
Expected: FAIL — `resolveSmTechIds` is not exported.

- [ ] **Step 3: Add `resolveSmTechIds` to `catalog-data.js` (after the `humanizeTag`/`projectTutorial` helpers, before `loadGroupContext` at `:69`)**

```javascript
/**
 * Resolve a group's/mission's product-tag semaphore IDs for SSR sm_tech_ids
 * emission. Reads the join entity for the owner, joins tag_ID → Tags, and
 * returns the non-null semaphoreIds of isActualTag rows. Fail-open: any error
 * → [] (never breaks the serve path).
 *
 * @param {object} db          CDS db service
 * @param {string} joinName    'GroupTags' | 'MissionTags'
 * @param {string} ownerCol    'group_ID' | 'mission_ID'
 * @param {string} ownerId     the group/mission ID
 * @returns {Promise<string[]>}
 */
export async function resolveSmTechIds(db, joinName, ownerCol, ownerId) {
  try {
    const ents = cds.entities(NAMESPACE);
    const Join = ents[joinName];
    const { Tags } = ents;
    if (!Join || !Tags || !ownerId) return [];
    const links = await db.run(SELECT.from(Join).columns('tag_ID').where({ [ownerCol]: ownerId }));
    const tagIds = [...new Set(links.map(l => l.tag_ID).filter(Boolean))];
    if (tagIds.length === 0) return [];
    const tags = await db.run(
      SELECT.from(Tags).columns('ID', 'semaphoreId', 'isActualTag').where({ ID: { in: tagIds }, isActualTag: true }),
    );
    const out = [];
    for (const t of tags) {
      if (t.semaphoreId === null || t.semaphoreId === undefined || t.semaphoreId === '') continue;
      out.push(String(t.semaphoreId));
    }
    return out;
  } catch (err) {
    console.error('[catalog-data] resolveSmTechIds failed:', err.message);
    return [];
  }
}
```

- [ ] **Step 4: Attach `smTechIds` in both loaders**

In `loadGroupContext`, before the `return {` (at `:109`), add:

```javascript
  const db = await cds.connect.to('db');
  const smTechIds = await resolveSmTechIds(db, 'GroupTags', 'group_ID', group.ID);
```

and add `smTechIds,` to the returned object (alongside `level,` at `:114`).

In `loadMissionContext`, before its `return {`, add the analogous lines:

```javascript
  const db = await cds.connect.to('db');
  const smTechIds = await resolveSmTechIds(db, 'MissionTags', 'mission_ID', mission.ID);
```

and add `smTechIds,` to that function's returned object.

> The loaders already use `cds.entities` + `SELECT` freely, so `cds.connect.to('db')` matches the module's runtime. If a `db` handle is already in scope in either loader, reuse it rather than reconnecting.

- [ ] **Step 5: Copy `smTechIds` into pageMeta in `catalog-renderer.js`**

In `renderCatalogPage`, the group branch pageMeta (`:265-271`) — add after `description:`:

```javascript
        smTechIds: ctx.smTechIds ?? [],
```

Do the same in the mission branch pageMeta (`:282-288`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/lib/catalog-data-smtechids.test.js`
Expected: PASS.

- [ ] **Step 7: Run the catalog SSR suite for regressions**

Run: `npx vitest run srv/__tests__/lib/ -t catalog`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/catalog-data.js srv/lib/catalog-renderer.js srv/__tests__/lib/catalog-data-smtechids.test.js
git commit -m "feat(sm-tech-ids): mission/group SSR resolves product-tag smTechIds"
```

---

### Task 8: Topic-detail SSR — carry `semaphoreId` → `meta.smTechIds`

**Files:**
- Modify: `srv/lib/topics-query.js` (`buildTopicDetailPayload` tagRow read at `:127`; return object at `:207-211`)
- Modify: `srv/lib/publish-topics.js` (meta object at `:78-83`)
- Test: `srv/__tests__/lib/publish-topics-smtechids.test.js`

**Interfaces:**
- Consumes: `buildTopicDetailPayload` payload gains `smTechIds: string[]`.
- Produces: `publish-topics.js` sets `meta.smTechIds = topic.smTechIds` (from Task 6, `composeShell` emits when non-empty).

- [ ] **Step 1: Extend the tagRow read in `topics-query.js` (`:127`)**

```javascript
    const tagRow = await db.run(SELECT.one.from(Tags).columns('ID', 'semaphoreId', 'isActualTag').where({ titlePath: tag.titlePath }));
```

- [ ] **Step 2: Compute + return `smTechIds` in the success payload**

Just before the final `return { slug: tag.slug, … }` (at `:207`), add:

```javascript
    // sm_tech_ids: a topic IS a tag — emit its own semaphoreId when it is a
    // product tag. Empty otherwise (composeShell then emits no meta).
    const smTechIds = (tagRow && tagRow.isActualTag && tagRow.semaphoreId)
      ? [String(tagRow.semaphoreId)]
      : [];
```

and add `smTechIds,` to that returned object (alongside `relatedChannels,`).

> The other early-return branches (notFound / redirect / catch at `:121-122`, `:213`) intentionally omit `smTechIds` — publish-topics treats `undefined` as "emit nothing", matching fail-open.

- [ ] **Step 3: Write the failing test**

```javascript
// srv/__tests__/lib/publish-topics-smtechids.test.js
import { describe, it, expect } from 'vitest';
import { renderTopicsIntoSession } from '../../lib/publish-topics.js';

// Minimal shell with a description meta anchor so composeShell can insert.
const shell = {
  before: '<head><meta name="description" content="x"></head>',
  after: '</body>',
};

function makeDeps(topic) {
  return {
    loadLiveTags: async () => [{ slug: topic.slug, label: topic.label, facet: 'software-product', segments: ['sap-hana'] }],
    loadTopicCorpus: async () => ({ live: [{ slug: topic.slug, label: topic.label, facet: 'software-product', segments: ['sap-hana'] }] }),
    buildTopicDetailPayload: async () => topic,
  };
}

describe('publish-topics sm_tech_ids', () => {
  it('emits sm_tech_ids for a product-tag topic', async () => {
    const captured = {};
    const helpers = { appendToSession: async ({ files }) => Object.assign(captured, files) };
    await renderTopicsIntoSession({
      db: {}, sessionId: 's', helpers, priorHashes: {}, shell,
      deps: makeDeps({ slug: 'sap-hana', label: 'SAP HANA', tutorials: [], concepts: [], smTechIds: ['7355001'] }),
    });
    const blob = Buffer.from(captured['topic-sap-hana'], 'base64');
    const { gunzipSync } = await import('node:zlib');
    const html = gunzipSync(blob).toString('utf-8');
    expect(html).toContain('<meta name="sm_tech_ids" content="en-US,7355001">');
  });

  it('emits no sm_tech_ids for a non-product topic', async () => {
    const captured = {};
    const helpers = { appendToSession: async ({ files }) => Object.assign(captured, files) };
    await renderTopicsIntoSession({
      db: {}, sessionId: 's', helpers, priorHashes: {}, shell,
      deps: makeDeps({ slug: 'some-topic', label: 'Some Topic', tutorials: [], concepts: [], smTechIds: [] }),
    });
    const blob = Buffer.from(captured['topic-some-topic'], 'base64');
    const { gunzipSync } = await import('node:zlib');
    const html = gunzipSync(blob).toString('utf-8');
    expect(html).not.toContain('sm_tech_ids');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run srv/__tests__/lib/publish-topics-smtechids.test.js`
Expected: FAIL — meta not present (publish-topics doesn't set `meta.smTechIds` yet).

- [ ] **Step 5: Set `meta.smTechIds` in `publish-topics.js` (meta object at `:78-83`)**

```javascript
      const meta = {
        kind: 'topic',
        slug: topic.slug,
        title: topic.label,
        description: topicMetaDescription(topic),
        smTechIds: topic.smTechIds ?? [],
      };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run srv/__tests__/lib/publish-topics-smtechids.test.js`
Expected: PASS (both cases).

- [ ] **Step 7: Run the topics/publish suites for regressions**

Run: `npx vitest run srv/__tests__/lib/ -t topic`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/topics-query.js srv/lib/publish-topics.js srv/__tests__/lib/publish-topics-smtechids.test.js
git commit -m "feat(sm-tech-ids): topic-detail SSR emits sm_tech_ids for product tags"
```

---

### Task 9: Hybrid + smoke coverage

**Files:**
- Create/Modify: `test/hybrid/sm-tech-ids.test.js` (hybrid, real DEV HANA via `cds bind --exec`)
- Modify: the post-deploy smoke suite (`test/smoke/` — check for the existing content-page smoke file and extend it)

**Interfaces:**
- Consumes: `/build/tag-semaphore` feed; deployed pages.
- Produces: hybrid + smoke assertions guarding the end-to-end contract.

- [ ] **Step 1: Hybrid test — the feed carries real semaphore IDs**

```javascript
// test/hybrid/sm-tech-ids.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const { GET } = cds.test(process.cwd());

describe('sm_tech_ids feed (hybrid, real HANA)', () => {
  it('/build/tag-semaphore returns a non-empty product-tag map', async () => {
    const res = await GET('/build/tag-semaphore');
    expect(res.status).toBe(200);
    const entries = Object.entries(res.data.map);
    expect(entries.length).toBeGreaterThan(0);
    // at least one product tag maps to a Semaphore-style numeric ID
    const productEntry = entries.find(([md]) => md.startsWith('software-product>'));
    expect(productEntry).toBeTruthy();
    expect(String(productEntry[1])).toMatch(/^\d{4,}/);
  });
});
```

> Match the existing hybrid harness bootstrap — copy the top-of-file setup from the closest `test/hybrid/*` test (the #385 semaphore-backfill test uses the same HANA binding). Run: `npm run test:hybrid` (requires `cf login` + `cds bind`).

- [ ] **Step 2: Run the hybrid test**

Run: `npm run test:hybrid -- test/hybrid/sm-tech-ids.test.js` (or the repo's hybrid invocation — check `jq '.scripts["test:hybrid"]' package.json`)
Expected: PASS against DEV HANA.

- [ ] **Step 3: Add post-deploy smoke assertions**

Extend the existing content-page smoke test (grep `test/smoke/` for the file that curls a tutorial + a mission). Add assertions that:
- a known tutorial's served HTML contains `name="sm_tech_ids"` with an `en-US,`-prefixed content,
- a known mission (`/tutorials/mission-…/`) and a known `/topics/<product-slug>/` detail page do the same,
- the topics **index** `/topics/` and a `/browse/` page contain **no** `sm_tech_ids`.

```javascript
// inside the existing smoke describe block (adapt selectors to that file's helpers)
it('tutorial page carries sm_tech_ids', async () => {
  const html = await fetchText(`${BASE}/tutorials/${KNOWN_PRODUCT_TUTORIAL_SLUG}/`);
  expect(html).toMatch(/name="sm_tech_ids" content="en-US,[^"]+"/);
});

it('topics index carries no sm_tech_ids', async () => {
  const html = await fetchText(`${BASE}/topics/`);
  expect(html).not.toContain('sm_tech_ids');
});
```

> `fetchText`, `BASE`, and slug constants come from the existing smoke file — reuse them; do not invent new helpers. Pick a `KNOWN_PRODUCT_TUTORIAL_SLUG` that the hybrid feed confirms has a product tag. Smoke self-skips without `SMOKE_BASE_URL`, so this is post-deploy only.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/sm-tech-ids.test.js test/smoke/
git commit -m "test(sm-tech-ids): hybrid feed + post-deploy smoke coverage"
```

---

## Self-Review

**1. Spec coverage:**
- Component 1 (`semaphore-tags.js`) → Task 1. ✓
- Component 2 (`/build/tag-semaphore`) → Task 2. ✓
- Component 3 (build frontmatter) → Tasks 3 (render-frontmatter) + 4 (fetch-tutorials). ✓
- Component 4 (Hugo emit) → Task 5. ✓
- Component 5 (composeShell + opt-in callers) → Task 6 (composeShell) + Task 7 (group/mission) + Task 8 (topic detail). ✓
- Excluded pages (browse/verb/sitemap/home/concept/puzzle/channel/topics-index) → never set `meta.smTechIds`; asserted in Task 9 smoke. ✓
- Testing section (unit/hybrid/smoke) → Tasks 1,2,3,6,7,8 (unit) + Task 9 (hybrid+smoke). ✓
- srv-qa cp-list audit → Task 6 Step 7. ✓
- Content-cache fast-path fingerprint (fail-open re-emit) → Task 4 Step 4 (a spec-implied correctness point, made explicit). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". The two `>`-note callouts (fingerprint destructure shape in Task 4; `SELECT` stringify in Task 7's fake) are explicit verification steps with a concrete fallback, not deferred work.

**3. Type consistency:**
- `getSemaphoreMdMap(db) → Record<string,string>` / `formatSmTechIds(ids, locale) → string` — defined Task 1, consumed identically in Tasks 2, 6.
- `smTechIds: string[]` — the single shape threaded through frontmatter (Task 3), pageMeta (Task 7), topic payload (Task 8), and `meta.smTechIds` (Tasks 6-8). No name drift.
- `semaphoreMap: Record<string,string>` — Task 3 interface, Task 4 arg, same type.
- `resolveSmTechIds(db, joinName, ownerCol, ownerId) → Promise<string[]>` — Task 7, used only within Task 7.
