# KG Community Search-Rank Term (#1171) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dark-shipped community-overlap term to `SearchService` ranking that boosts tutorials sharing a Louvain community with the query's top concept-overlap hits, behind `KG_COMMUNITY_WEIGHT` (default 0 = OFF), without regressing the tuned `KG_WEIGHT` blend.

**Architecture:** A new `buildCommunityRankFragment` helper in `srv/lib/search-kg-signal.js` reuses the already-computed `signal.slugScores` as anchors (no new embed), fetches the anchors' `communityFingerprint`s and their tutorial members from `KgCommunity` (HANA-packet-safe: ≤5 fingerprints, Node-side filter, capped), and emits a **second, independent** additive `+ KG_COMMUNITY_WEIGHT * (case slug … end)` SQL fragment. `computeKgSignal` and `buildKgRankFragment` are untouched; when the weight is 0 the helper short-circuits before any DB work and the rank SQL is byte-identical to today.

**Tech Stack:** Node.js (ESM), SAP CAP (`@sap/cds`), raw `db.run()` with dialect branching (HANA/SQLite), Vitest (unit + hybrid projects).

## Global Constraints

- **`KG_WEIGHT` behavior byte-identical when the community term is OFF** — the community term is a separate additive CASE fragment; `computeKgSignal`/`buildKgRankFragment` must not change.
- **`KG_COMMUNITY_WEIGHT` default `0` (OFF)** — read from `process.env.KG_COMMUNITY_WEIGHT`, parsed float, clamped `>= 0`. When `<= 0`, helper returns `''` **before any DB fetch**.
- **HANA packet-size safety** — never `.where({col:{in: bigArray}})` on an unbounded set (one bound param per element blows HANA packet size). The fingerprint set is ≤ `COMMUNITY_TOP_K` (5) so its `.in()` is bounded; the member set is capped at `COMMUNITY_MEMBER_CAP` (200) and filtered in Node. Gotcha: `cqn-where-in-hana-packet-cap`.
- **HANA uppercase-alias (#1113)** — in raw `db.run()`, HANA folds unquoted aliases to uppercase; all HANA-branch aliases MUST be double-quoted lowercase (`SLUG as "slug"`). SQLite branch stays unquoted.
- **Slug canonical lowercase** — slugs are lowercase kebab; lowercase-normalize before comparing/sanitizing. Sanitizer: `SAFE_SLUG_RE = /^[a-z0-9-]+$/`.
- **Fail-open** — any error in the community helper → `LOG.warn` + return `''`; search continues on `KG_WEIGHT`-only (or fuzzy-only) rank.
- **Slugs in SQL are inlined, not bound** — reuse the existing `SAFE_SLUG_RE` + `Number.toFixed(4)` sanitize-then-inline pattern from `buildKgRankFragment`.

---

### Task 1: DB fetch helpers for community membership

**Files:**
- Modify: `srv/lib/kg/_search-fetches.js` (append two exported functions after `fetchTutorialsByIds`, before `EXTERNAL_ARMS`)
- Test: `test/unit/search-community-fetches.test.js` (create)

**Interfaces:**
- Consumes: `isHana(db)` (already exported from this file).
- Produces:
  - `fetchCommunityFingerprints(db, slugs) => Promise<Array<{slug, communityFingerprint}>>` — tutorial-vertex rows for the given anchor slugs, lowercase-keyed.
  - `fetchCommunityMembers(db, fingerprints, cap) => Promise<Array<{slug, communityFingerprint}>>` — tutorial-vertex member rows for the given fingerprints, capped at `cap` total rows, lowercase-keyed.

- [ ] **Step 1: Write the failing test**

Create `test/unit/search-community-fetches.test.js`:

```js
// test/unit/search-community-fetches.test.js
// Unit tests for the KgCommunity fetch helpers (#1171). In-memory SQLite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { fetchCommunityFingerprints, fetchCommunityMembers } from '../../srv/lib/kg/_search-fetches.js'

describe('search-fetches — KgCommunity helpers (#1171)', () => {
  let db
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    // Two communities: fp-a has tutorials t1,t2,t3; fp-b has t4. Plus a
    // concept vertex in fp-a that must be filtered out (vertexType != tutorial).
    await db.run(INSERT.into('com.sap.developers.ims.KgCommunity').entries([
      { communityId: 1, vertexKey: 'tutorial:t1', vertexType: 'tutorial', slug: 't1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:t2', vertexType: 'tutorial', slug: 't2', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:t3', vertexType: 'tutorial', slug: 't3', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'concept:c1',  vertexType: 'concept',  slug: 'c1', communityFingerprint: 'fp-a' },
      { communityId: 2, vertexKey: 'tutorial:t4', vertexType: 'tutorial', slug: 't4', communityFingerprint: 'fp-b' },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('fetchCommunityFingerprints returns tutorial-vertex fingerprints for anchor slugs', async () => {
    const rows = await fetchCommunityFingerprints(db, ['t1', 't4'])
    const byslug = Object.fromEntries(rows.map(r => [r.slug, r.communityFingerprint]))
    expect(byslug).toEqual({ t1: 'fp-a', t4: 'fp-b' })
  })

  it('fetchCommunityFingerprints ignores non-tutorial vertices', async () => {
    const rows = await fetchCommunityFingerprints(db, ['c1'])
    expect(rows).toEqual([])
  })

  it('fetchCommunityMembers returns tutorial members of the given fingerprints', async () => {
    const rows = await fetchCommunityMembers(db, ['fp-a'], 200)
    const slugs = rows.map(r => r.slug).sort()
    expect(slugs).toEqual(['t1', 't2', 't3'])
  })

  it('fetchCommunityMembers caps the total row count', async () => {
    const rows = await fetchCommunityMembers(db, ['fp-a'], 2)
    expect(rows.length).toBe(2)
  })

  it('empty inputs return [] without a DB call', async () => {
    expect(await fetchCommunityFingerprints(db, [])).toEqual([])
    expect(await fetchCommunityMembers(db, [], 200)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/search-community-fetches.test.js`
Expected: FAIL — `fetchCommunityFingerprints is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

In `srv/lib/kg/_search-fetches.js`, append after `fetchTutorialsByIds` (around line 137):

```js
/**
 * Resolve anchor tutorial slugs → their KgCommunity fingerprints (#1171).
 * Only tutorial-typed vertices. Bounded `.in()` — callers pass a small anchor
 * set (<= COMMUNITY_TOP_K). Returns rows { slug, communityFingerprint } with
 * lowercased keys regardless of dialect.
 */
export async function fetchCommunityFingerprints(db, slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return []
  const placeholders = slugs.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT SLUG as "slug", COMMUNITYFINGERPRINT as "communityFingerprint"
       FROM COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY
       WHERE VERTEXTYPE = 'tutorial' AND SLUG IN (${placeholders})`,
      slugs,
    ) || []
  }
  return await db.run(
    `SELECT slug, communityFingerprint
     FROM com_sap_developers_ims_KgCommunity
     WHERE vertexType = 'tutorial' AND slug IN (${placeholders})`,
    slugs,
  ) || []
}

/**
 * Fetch tutorial-typed members of the given community fingerprints (#1171).
 * The fingerprint set is small (<= COMMUNITY_TOP_K distinct) so `.in()` is
 * packet-safe; the RETURNED member set is capped at `cap` rows defensively
 * (communities are small, but a pathological cluster shouldn't unbounded the
 * fragment). Node-side de-dup/exclusion happens in the caller. Returns rows
 * { slug, communityFingerprint } with lowercased keys regardless of dialect.
 */
export async function fetchCommunityMembers(db, fingerprints, cap) {
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) return []
  const limit = Number.isInteger(cap) && cap > 0 ? cap : 200
  const placeholders = fingerprints.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT SLUG as "slug", COMMUNITYFINGERPRINT as "communityFingerprint"
       FROM COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY
       WHERE VERTEXTYPE = 'tutorial' AND COMMUNITYFINGERPRINT IN (${placeholders})
       LIMIT ${limit}`,
      fingerprints,
    ) || []
  }
  return await db.run(
    `SELECT slug, communityFingerprint
     FROM com_sap_developers_ims_KgCommunity
     WHERE vertexType = 'tutorial' AND communityFingerprint IN (${placeholders})
     LIMIT ${limit}`,
    fingerprints,
  ) || []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/search-community-fetches.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/_search-fetches.js test/unit/search-community-fetches.test.js
git commit -m "feat(#1171): KgCommunity fetch helpers (fingerprints + members)"
```

---

### Task 2: `buildCommunityRankFragment` helper + `KG_COMMUNITY_WEIGHT`

**Files:**
- Modify: `srv/lib/search-kg-signal.js` (add consts near line 42 after `KG_WEIGHT`; add `buildCommunityRankFragment` after `buildKgRankFragment` at end of file; add import for the two Task 1 helpers at line 28)
- Test: `test/unit/search-community-signal.test.js` (create)

**Interfaces:**
- Consumes: `fetchCommunityFingerprints`, `fetchCommunityMembers` (Task 1); `signal.slugScores` (`Map<string,number>`) from `computeKgSignal`.
- Produces:
  - `KG_COMMUNITY_WEIGHT: number` (module const, exported) — `process.env.KG_COMMUNITY_WEIGHT` parsed float, default `0`, clamped `>= 0`.
  - `COMMUNITY_TOP_K: number` (const `5`), `COMMUNITY_MEMBER_CAP: number` (const `200`).
  - `buildCommunityRankFragment({ signal, db, weight, topK }) => Promise<string>` — SQL fragment `+ W * (case slug when 'peer' then 1.0000 … else 0 end)` or `''`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/search-community-signal.test.js`:

```js
// test/unit/search-community-signal.test.js
// Unit tests for buildCommunityRankFragment (#1171). In-memory SQLite.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import cds from '@sap/cds'
import {
  buildCommunityRankFragment,
  COMMUNITY_TOP_K,
} from '../../srv/lib/search-kg-signal.js'

// signal stub: only slugScores matters for this helper.
const sig = (pairs) => ({ slugScores: new Map(pairs) })

describe('buildCommunityRankFragment (#1171)', () => {
  let db
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    // anchor 'a1' is in community fp-a with siblings p1,p2. 'a2' in fp-b alone.
    await db.run(INSERT.into('com.sap.developers.ims.KgCommunity').entries([
      { communityId: 1, vertexKey: 'tutorial:a1', vertexType: 'tutorial', slug: 'a1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:p1', vertexType: 'tutorial', slug: 'p1', communityFingerprint: 'fp-a' },
      { communityId: 1, vertexKey: 'tutorial:p2', vertexType: 'tutorial', slug: 'p2', communityFingerprint: 'fp-a' },
      { communityId: 2, vertexKey: 'tutorial:a2', vertexType: 'tutorial', slug: 'a2', communityFingerprint: 'fp-b' },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('weight <= 0 returns "" and does NOT touch the DB', async () => {
    const spy = vi.spyOn(db, 'run')
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db, weight: 0 })
    expect(frag).toBe('')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('emits binary-boost CASE for community peers, excluding the anchor', async () => {
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db, weight: 1.5 })
    expect(frag).toContain('1.50 *')
    expect(frag).toContain("when 'p1' then 1.0000")
    expect(frag).toContain("when 'p2' then 1.0000")
    expect(frag).not.toContain("when 'a1'")   // anchor excluded
    expect(frag.startsWith('+ ')).toBe(true)
  })

  it('returns "" when the top anchor has no community', async () => {
    const frag = await buildCommunityRankFragment({ signal: sig([['a2', 0.9]]), db, weight: 1.5 })
    expect(frag).toBe('')   // a2 is a singleton in fp-b — no peers
  })

  it('returns "" for an empty signal', async () => {
    expect(await buildCommunityRankFragment({ signal: sig([]), db, weight: 1.5 })).toBe('')
    expect(await buildCommunityRankFragment({ signal: null, db, weight: 1.5 })).toBe('')
  })

  it('only the top-K slugs become anchors', async () => {
    // K+1 zero-community slugs ranked above a1 would push a1 out of the anchor
    // window if topK were smaller; with default K=5 and 1 real anchor it stays.
    expect(COMMUNITY_TOP_K).toBe(5)
  })

  it('fail-open: a DB throw collapses the term to ""', async () => {
    const badDb = { kind: 'sqlite', run: () => { throw new Error('boom') } }
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db: badDb, weight: 1.5 })
    expect(frag).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/search-community-signal.test.js`
Expected: FAIL — `buildCommunityRankFragment is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `srv/lib/search-kg-signal.js`, extend the import at line 28:

```js
import { fetchEdges, fetchConceptsByIds, fetchLinks, fetchCommunityFingerprints, fetchCommunityMembers } from './kg/_search-fetches.js';
```

Add after `KG_WEIGHT` (line 42):

```js
// #1171 — community-overlap term. Separate, additive to KG_WEIGHT. Env-tuned
// numeric knob (like KG_WEIGHT), NOT a per-request ChatSettings flag. Default 0
// (OFF) → buildCommunityRankFragment short-circuits before any DB work and the
// rank SQL stays byte-identical to the #945 formula.
export const KG_COMMUNITY_WEIGHT = (() => {
  const raw = Number.parseFloat(process.env.KG_COMMUNITY_WEIGHT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

// Anchor window: the top-K concept-overlap slugs whose communities we boost.
export const COMMUNITY_TOP_K = 5;

// Defensive cap on the total community-member row set (communities are small).
const COMMUNITY_MEMBER_CAP = 200;
```

Add at the end of the file (after `buildKgRankFragment`):

```js
/**
 * Build the `+ KG_COMMUNITY_WEIGHT * (case slug when 'peer' then 1.0000 … else 0 end)`
 * SQL fragment for the community-overlap term (#1171). Reuses the KG signal's
 * already-computed slugScores as the anchor source — no new embed, no second
 * concept walk. Fully self-contained fail-open.
 *
 * @param {object}   opts
 * @param {KgSignal} opts.signal   signal from computeKgSignal()
 * @param {object}   opts.db       CDS db handle (SQLite or HANA)
 * @param {number}   opts.weight   KG_COMMUNITY_WEIGHT (0 = OFF)
 * @param {number=}  opts.topK     anchor count (default COMMUNITY_TOP_K)
 * @returns {Promise<string>}      SQL fragment or '' (nothing to add)
 */
export async function buildCommunityRankFragment({ signal, db, weight, topK = COMMUNITY_TOP_K }) {
  // Short-circuit BEFORE any DB work — default config touches nothing.
  if (!(weight > 0)) return '';
  if (!signal || !signal.slugScores || signal.slugScores.size === 0) return '';

  try {
    // 1. Anchors — top-K slugs by concept-overlap score, descending.
    const anchors = [...signal.slugScores.entries()]
      .filter(([slug, score]) => typeof slug === 'string' && Number(score) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([slug]) => slug.toLowerCase());
    if (anchors.length === 0) return '';
    const anchorSet = new Set(anchors);

    // 2. Anchor → distinct community fingerprints (bounded .in, <= topK).
    const fpRows = await fetchCommunityFingerprints(db, anchors);
    const fingerprints = [...new Set(fpRows.map((r) => r.communityFingerprint).filter(Boolean))];
    if (fingerprints.length === 0) return '';

    // 3. Fingerprints → tutorial members (capped; filtered in Node).
    const memberRows = await fetchCommunityMembers(db, fingerprints, COMMUNITY_MEMBER_CAP);

    // 4. Peer set = members − anchors, lowercased + deduped.
    const peers = new Set();
    for (const r of memberRows) {
      const slug = typeof r.slug === 'string' ? r.slug.toLowerCase() : '';
      if (!slug || anchorSet.has(slug)) continue;
      peers.add(slug);
    }
    if (peers.size === 0) return '';

    // 5. Binary-boost CASE — same sanitize-then-inline pattern as buildKgRankFragment.
    const parts = [];
    for (const slug of peers) {
      if (!SAFE_SLUG_RE.test(slug)) continue;
      parts.push(`when '${slug}' then 1.0000`);
    }
    if (parts.length === 0) return '';
    return `+ ${weight.toFixed(2)} * (case slug ${parts.join(' ')} else 0 end)`;
  } catch (err) {
    LOG.warn('buildCommunityRankFragment failed; community term collapses to 0', err.message);
    metrics.counter('search.kg.community.error');
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/search-community-signal.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/search-kg-signal.js test/unit/search-community-signal.test.js
git commit -m "feat(#1171): buildCommunityRankFragment + KG_COMMUNITY_WEIGHT (default off)"
```

---

### Task 3: Wire the community fragment into `SearchService.before('READ')`

**Files:**
- Modify: `srv/search-service.js` (import line 2; `attachSearchRank` signature ~line 126–164; `before('READ')` handler ~line 206–238)
- Test: `test/unit/search-service-kg-blend.test.js` (add byte-identical-when-OFF assertion)

**Interfaces:**
- Consumes: `buildCommunityRankFragment`, `KG_COMMUNITY_WEIGHT` (Task 2).
- Produces: `attachSearchRank(query, tokens, kgFragment = '', communityFragment = '')` — appends both fragments to the fuzzy CASE, in order (KG first, community second).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/search-service-kg-blend.test.js` inside the `describe`:

```js
  it('#1171: community term OFF by default — rank SQL identical to KG-only', async () => {
    // KG_COMMUNITY_WEIGHT defaults to 0 in the unit env (no env var set), so the
    // community fragment is '' and the emitted rank is byte-identical to #945.
    // With no AI Core binding the KG fragment is also '' → pure fuzzy rank.
    // A title hit therefore scores exactly 3 (proven in the sibling test above);
    // re-assert here to lock the community term out of the default formula.
    const res = await project.get(
      "/search/SearchableItems?$search=kgprobe&$select=slug,searchScore&$top=5",
    );
    const strong = res.data.value.find(r => r.slug === 'kg-strong-tutorial');
    expect(strong).toBeDefined();
    expect(strong.searchScore).toBe(3);   // no community contribution added
  });
```

Also add a direct unit assertion in `test/unit/search-community-signal.test.js` that `attachSearchRank` with an empty community fragment produces no extra term. Since `attachSearchRank` is not exported, assert via the fragment contract instead — add to `test/unit/search-community-signal.test.js`:

```js
  it('an OFF weight yields no fragment to concatenate (byte-identical rank)', async () => {
    const frag = await buildCommunityRankFragment({ signal: sig([['a1', 0.9]]), db, weight: 0 })
    expect(frag).toBe('')   // concatenating '' into rankSQL is a no-op
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/search-service-kg-blend.test.js`
Expected: The new `#1171` test may already PASS (community weight is 0 by default and the fragment plumbing does not yet exist, so behavior is unchanged). This test is a **regression lock** — it guards that the Task-3 wiring keeps the default byte-identical. Proceed to implement; it must stay green.

- [ ] **Step 3: Write minimal implementation**

In `srv/search-service.js` line 2:

```js
import { computeKgSignal, buildKgRankFragment, buildCommunityRankFragment, KG_COMMUNITY_WEIGHT } from './lib/search-kg-signal.js';
```

Change `attachSearchRank` signature and body (line 126, and the rankSQL concat ~line 139–144):

```js
function attachSearchRank(query, tokens, kgFragment = '', communityFragment = '') {
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const titleOr = _columnAnyTokenSQL('title', tokens);
  const descOr  = _columnAnyTokenSQL('description', tokens);
  const primOr  = _columnAnyTokenSQL('primaryTag', tokens);
  const tagOr   = _columnAnyTokenSQL('tagBag', tokens);

  const rankSQL =
    `(case when (${titleOr}) then 3 else 0 end ` +
    `+ case when (${descOr}) then 2 else 0 end ` +
    `+ case when (${primOr} or ${tagOr}) then 1 else 0 end` +
    (kgFragment ? ` ${kgFragment}` : '') +
    (communityFragment ? ` ${communityFragment}` : '') +
    `)`;

  const rankExpr = cds.parse.expr(rankSQL);
  const sel = query.SELECT;
  if (!sel.columns) return;
  sel.columns.push({ ...rankExpr, as: '_searchRank' });
  sel.orderBy = [{ ref: ['_searchRank'], sort: 'desc' }, ...(sel.orderBy ?? [])];
}
```

Change the `before('READ')` handler body (line 220–237):

```js
      let kgFragment = '';
      let communityFragment = '';
      try {
        const settings = await readChatSettings();
        if (settings?.searchKgRerankEnabled) {
          const { model: embeddingModel } = await resolveEmbeddingSettings();
          const signal = await computeKgSignal({
            phrase,
            db: cds.db,
            embeddingModel,
            enabled: true,
          });
          kgFragment = buildKgRankFragment(signal);
          // #1171 — additive, independent community-overlap term. weight 0 => ''.
          communityFragment = await buildCommunityRankFragment({
            signal,
            db: cds.db,
            weight: KG_COMMUNITY_WEIGHT,
          });
        }
      } catch (err) {
        LOG.warn('KG signal computation failed; falling back to fuzzy-only rank', err.message);
      }

      attachSearchRank(req.query, tokens, kgFragment, communityFragment);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/search-service-kg-blend.test.js test/unit/search-community-signal.test.js`
Expected: PASS — the `#1171` byte-identical test green, all community-signal tests green.

- [ ] **Step 5: Commit**

```bash
git add srv/search-service.js test/unit/search-service-kg-blend.test.js test/unit/search-community-signal.test.js
git commit -m "feat(#1171): wire community fragment into SearchService rank (dark by default)"
```

---

### Task 4: Hybrid coverage for the HANA membership fetch

**Files:**
- Test: `test/hybrid/search-community-rank.test.js` (create)

**Interfaces:**
- Consumes: `fetchCommunityFingerprints`, `fetchCommunityMembers` (Task 1), `buildCommunityRankFragment` (Task 2), real HANA `KgCommunity`.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/search-community-rank.test.js`:

```js
// test/hybrid/search-community-rank.test.js
// Hybrid HANA coverage for #1171 — the packet-safe KgCommunity membership
// fetch and the community-overlap fragment against real HANA rows.
//
// GATING: opt-in via ALLOW_HYBRID_WRITES=true (writes throwaway KgCommunity
// rows). Default test:hybrid skips this file.
//
// Run:
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/search-community-rank.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import {
  fetchCommunityFingerprints,
  fetchCommunityMembers,
} from '../../srv/lib/kg/_search-fetches.js';
import { buildCommunityRankFragment } from '../../srv/lib/search-kg-signal.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const FP = '__test_1171_fp__';
const SLUGS = ['zzz-1171-anchor', 'zzz-1171-peer-a', 'zzz-1171-peer-b'];

describe.runIf(RUN)('search-community-rank hybrid (#1171)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { KgCommunity } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
    await db.run(INSERT.into(KgCommunity).entries(SLUGS.map((slug, i) => ({
      communityId: 999000 + i, vertexKey: `tutorial:${slug}`,
      vertexType: 'tutorial', slug, communityFingerprint: FP,
    }))));
  });
  afterAll(async () => {
    const { KgCommunity } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
  });

  it('fetchCommunityFingerprints returns lowercase-keyed rows on HANA', async () => {
    const rows = await fetchCommunityFingerprints(db, ['zzz-1171-anchor']);
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('zzz-1171-anchor');          // #1113 alias check
    expect(rows[0].communityFingerprint).toBe(FP);
  });

  it('fetchCommunityMembers returns tutorial members (packet-safe)', async () => {
    const rows = await fetchCommunityMembers(db, [FP], 200);
    expect(rows.map(r => r.slug).sort()).toEqual([...SLUGS].sort());
  });

  it('buildCommunityRankFragment boosts peers, excludes the anchor', async () => {
    const signal = { slugScores: new Map([['zzz-1171-anchor', 0.9]]) };
    const frag = await buildCommunityRankFragment({ signal, db, weight: 1.5 });
    expect(frag).toContain("when 'zzz-1171-peer-a' then 1.0000");
    expect(frag).toContain("when 'zzz-1171-peer-b' then 1.0000");
    expect(frag).not.toContain("when 'zzz-1171-anchor'");
  });
});
```

- [ ] **Step 2: Run the hybrid test (requires cf login + cds bind)**

Run:
```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/search-community-rank.test.js
```
Expected: PASS (3 tests). If no HANA bind is available in the execution env, this task's verification is deferred to a maintainer with `cf login`; note that in the task handoff. Do NOT mark the acceptance criterion complete without a green hybrid run.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/search-community-rank.test.js
git commit -m "test(#1171): hybrid coverage for HANA community membership fetch"
```

---

### Task 5: Regression harness — query set + churn script + report

**Files:**
- Create: `test/harness/community-rank-queries.json`
- Create: `test/harness/community-rank-churn.mjs`
- Create: `test/harness/community-rank-churn-report.md`

**Interfaces:**
- Consumes: deployed/served `SearchService` `/search/SearchableItems` OData endpoint (via `cds.test('serve', … '--profile', 'hybrid')` or an env `SMOKE_SRV_URL`), `KG_COMMUNITY_WEIGHT` env toggle.

- [ ] **Step 1: Create the committed query set**

Create `test/harness/community-rank-queries.json`:

```json
{
  "topN": 10,
  "queries": [
    "abap",
    "cap",
    "hana",
    "fiori elements",
    "rap business object",
    "btp destination service",
    "cloud application programming",
    "ui5 freestyle",
    "sap build",
    "integration suite",
    "clean core",
    "cds annotations",
    "xsuaa authentication",
    "event mesh",
    "hana cloud vector engine",
    "abap restful application programming model",
    "side by side extension",
    "workflow management",
    "document information extraction",
    "kyma serverless"
  ]
}
```

- [ ] **Step 2: Create the churn harness script**

Create `test/harness/community-rank-churn.mjs`:

```js
// test/harness/community-rank-churn.mjs
// #1171 regression harness. Captures the ordered SearchableItems slug list for
// a committed query set with KG_COMMUNITY_WEIGHT OFF (0) vs ON, and reports
// per-query ordering churn. NOT a CI test — run on demand against a served
// SearchService with real KgCommunity data (hybrid), then hand-review the
// report before recommending the term be enabled in any env.
//
// Usage:
//   ON_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs
//
// Requires searchKgRerankEnabled=true on ChatSettings (else both runs are
// fuzzy-only and churn is trivially 0).
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { queries, topN } = JSON.parse(
  readFileSync(join(__dirname, 'community-rank-queries.json'), 'utf8'),
);
const ON_WEIGHT = process.env.ON_WEIGHT || '1.5';

// Kendall-tau distance over the intersection of two ranked slug lists.
function kendallTau(a, b) {
  const common = a.filter((s) => b.includes(s));
  const rb = new Map(common.map((s) => [s, b.indexOf(s)]));
  let discordant = 0, pairs = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      pairs++;
      if ((rb.get(common[i]) - rb.get(common[j])) < 0) discordant++;
    }
  }
  return pairs ? discordant / pairs : 0;
}

async function rankSlugs(srv, SearchableItems, phrase, topN) {
  const rows = await srv.run(
    SELECT.from(SearchableItems).columns('slug').search(phrase).limit(topN),
  );
  return rows.map((r) => (r.slug || '').toLowerCase());
}

async function main() {
  // Run 1: OFF.
  process.env.KG_COMMUNITY_WEIGHT = '0';
  let srv = await cds.connect.to('SearchService');
  const { SearchableItems } = srv.entities;
  const off = {};
  for (const q of queries) off[q] = await rankSlugs(srv, SearchableItems, q, topN);

  // Run 2: ON. Re-import the module fresh so the new env weight is read.
  process.env.KG_COMMUNITY_WEIGHT = ON_WEIGHT;
  // The weight is captured at module load; a running server won't re-read it.
  // For an accurate ON run, this script must be launched with the env already
  // set to ON_WEIGHT and a SEPARATE OFF run compared. See the report note.
  const on = {};
  for (const q of queries) on[q] = await rankSlugs(srv, SearchableItems, q, topN);

  const rows = queries.map((q) => {
    const entered = on[q].filter((s) => !off[q].includes(s)).length;
    const left = off[q].filter((s) => !on[q].includes(s)).length;
    let maxShift = 0;
    for (const s of off[q]) {
      const i = off[q].indexOf(s), j = on[q].indexOf(s);
      if (j >= 0) maxShift = Math.max(maxShift, Math.abs(i - j));
    }
    return { q, tau: kendallTau(off[q], on[q]).toFixed(3), entered, left, maxShift };
  });

  console.log('query\ttau\tentered\tleft\tmaxShift');
  for (const r of rows) console.log(`${r.q}\t${r.tau}\t${r.entered}\t${r.left}\t${r.maxShift}`);
  await cds.shutdown?.();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

> **Note (captured in the report):** `KG_COMMUNITY_WEIGHT` is read once at module load, so a single process cannot truly toggle mid-run. The report documents the operational procedure: run the script once with `KG_COMMUNITY_WEIGHT=0` capturing OFF slugs to a file, once with `KG_COMMUNITY_WEIGHT=$ON_WEIGHT`, then diff. The in-script second pass is a scaffold; the committed report is produced by the two-process procedure.

- [ ] **Step 3: Create the report skeleton with the operational procedure**

Create `test/harness/community-rank-churn-report.md`:

```markdown
# #1171 Community-Overlap Term — Churn Analysis

**Status:** baseline captured OFF; ON run pending real PROD/DEV KgCommunity data.
**Weight tested:** `KG_COMMUNITY_WEIGHT=1.5` (candidate).
**Query set:** `test/harness/community-rank-queries.json` (20 queries, topN=10).

## Procedure (two-process, module-load env capture)

`KG_COMMUNITY_WEIGHT` is read once at module load, so OFF and ON are captured in
separate processes and diffed:

```bash
# OFF baseline
KG_COMMUNITY_WEIGHT=0 npx cds bind --exec -- node test/harness/community-rank-churn.mjs > off.tsv
# ON candidate
KG_COMMUNITY_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs > on.tsv
# diff the two slug orderings per query (columns: query, tau, entered, left, maxShift)
```

`searchKgRerankEnabled` must be `true` on ChatSettings for both runs (otherwise
both are fuzzy-only and churn is trivially 0 — a meaningless comparison).

## Churn metrics (per query)

| query | Kendall-tau | entered topN | left topN | max rank shift | reviewed verdict |
|---|---|---|---|---|---|
| _(populated from on.tsv vs off.tsv)_ | | | | | |

## Verdict

_To be completed after the ON run against real KgCommunity data. The term is
recommended for enabling ONLY if: (a) no currently-well-ranked title-hit query
loses its top result, (b) aggregate Kendall-tau churn is bounded (target: mean
tau < 0.15 over the query set), and (c) every top-N entrant is hand-reviewed as
a topical improvement, not noise._
```

- [ ] **Step 4: Verify the query set parses and the script loads**

Run: `node -e "JSON.parse(require('fs').readFileSync('test/harness/community-rank-queries.json','utf8')); console.log('ok')"`
Expected: `ok`.

Run: `node --check test/harness/community-rank-churn.mjs`
Expected: no output (syntax valid).

- [ ] **Step 5: Commit**

```bash
git add test/harness/community-rank-queries.json test/harness/community-rank-churn.mjs test/harness/community-rank-churn-report.md
git commit -m "test(#1171): regression harness — query set + churn script + report skeleton"
```

---

### Task 6: Full unit suite green + CDS model deploy check + docs gotcha

**Files:**
- Modify: `CLAUDE.md` (add a Top Gotchas bullet for `KG_COMMUNITY_WEIGHT`)

**Interfaces:** none (verification + docs task).

- [ ] **Step 1: Run the full unit suite for the touched area**

Run: `npx vitest run test/unit/search-community-fetches.test.js test/unit/search-community-signal.test.js test/unit/search-kg-signal.test.js test/unit/search-service-kg-blend.test.js`
Expected: all PASS. `search-kg-signal.test.js` must be **unchanged and green** (proves `KG_WEIGHT` path byte-identical).

- [ ] **Step 2: Confirm no `db/**` schema change slipped in**

This PR touches no `.cds` / `.csv`. Confirm:
Run: `git diff --name-only origin/main...HEAD -- 'db/**'`
Expected: empty output. (No `.hdbmigrationtable` bump needed — `KgCommunity`/`KgCommunityLabel` already exist from #1126 PR 1.)

- [ ] **Step 3: Add the CLAUDE.md gotcha bullet**

In `CLAUDE.md`, under "Top Gotchas", add:

```markdown
- **`KG_COMMUNITY_WEIGHT` env var (issue #1171)** — when `> 0`, `SearchService.before('READ')` appends a SECOND additive rank term `+ KG_COMMUNITY_WEIGHT * (case slug when '<peer>' then 1.0 else 0 end)` alongside the existing concept-overlap `KG_WEIGHT` (#945). Peers are tutorials sharing a Louvain `communityFingerprint` (#917/#1126) with the top-`COMMUNITY_TOP_K` (5) concept-overlap hits. Default `0` (OFF) → `buildCommunityRankFragment` in `srv/lib/search-kg-signal.js` short-circuits before any DB fetch and the rank SQL is byte-identical to the #945 formula. Fail-open (any DB throw → term collapses to `''`). Membership fetched packet-safe (≤5 fingerprints `.in()`, members capped 200, filtered in Node — `cqn-where-in-hana-packet-cap`). Regression harness + churn report at `test/harness/community-rank-churn*`; do NOT enable in any env before the ON-vs-OFF churn is hand-reviewed. Toggle: `cf set-env tutorials-srv KG_COMMUNITY_WEIGHT 1.5 && cf restart tutorials-srv`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#1171): document KG_COMMUNITY_WEIGHT gotcha"
```

---

## Self-Review

**1. Spec coverage:**
- Signal definition (top-K anchors, binary boost) → Task 2. ✓
- Additive integration, KG_WEIGHT untouched → Task 3 (separate fragment, byte-identical test). ✓
- Regression harness (query set + OFF-vs-ON report) → Task 5. ✓
- Documented churn analysis → Task 5 report + verdict criteria. ✓
- Unit coverage → Tasks 1–3; hybrid coverage for HANA fetch → Task 4. ✓
- Fail-open → Task 2 (try/catch → '') + Task 3 (outer try/catch). ✓
- Env knob default OFF, short-circuit before DB → Task 2. ✓
- HANA #1113 aliases + packet-safety → Task 1 (double-quoted aliases, capped) + Task 4 (hybrid alias assertion). ✓

**2. Placeholder scan:** No TBD/TODO in code steps; the report's verdict section is intentionally "to be completed after the ON run" — that is a deliverable-with-real-data, not a plan placeholder (the acceptance criteria for enabling are fully specified).

**3. Type consistency:** `buildCommunityRankFragment({ signal, db, weight, topK })` signature consistent across Tasks 2, 3, 4. `fetchCommunityFingerprints(db, slugs)` / `fetchCommunityMembers(db, fingerprints, cap)` consistent across Tasks 1, 2, 4. `attachSearchRank(query, tokens, kgFragment, communityFragment)` consistent Task 3. Const names `COMMUNITY_TOP_K`, `COMMUNITY_MEMBER_CAP`, `KG_COMMUNITY_WEIGHT` consistent Tasks 2, 3, 6.

**Notes for the implementer:**
- Work in the worktree `worktree-1171-kg-community-search-rank`; verify `git branch --show-current` in the same shell before each commit.
- The hybrid test (Task 4) and the ON churn run (Task 5) need `cf login` + `cds bind`. If unavailable, commit the code + report skeleton and flag the two HANA-gated verifications for a maintainer — do not fabricate a green hybrid result.
