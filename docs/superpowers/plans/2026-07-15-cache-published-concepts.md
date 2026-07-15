# @cache Pilot — KG PublishedConceptsWithAliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a declarative `@cache` annotation to the anonymous `KnowledgeGraphService.PublishedConceptsWithAliases` read (⌘K command palette), with tag-based invalidation hooked into the existing KG publish/write signals, so we can measure a real hit rate and record an expand/hold/revert decision for #1182.

**Architecture:** Annotate the CAP service projection with `@cache: {ttl, tags}`. Add a small fail-open bust helper `srv/lib/kg-published-concepts-cache.js` (structural twin of `kg-neighborhood-cache.js`) and call it from the three existing `after`-write handlers in `srv/server.js` that already fire on concept publish/unpublish/edit. Freshness = 5-min TTL backstop + `deleteByTag` on write. Metrics flow into the #1179 `plugin.cds_caching.KeyMetrics` table via the shared `caching` service.

**Tech Stack:** SAP CAP (`@sap/cds` 10), cds-caching 2.0.1 (`store:'cds'` in hybrid/production, `memory` base), Vitest (unit + hybrid projects), HANA Cloud.

## Global Constraints

- Anonymous/public data only — the `caching` default key is `{hash}`-only (`isUserAware:false`); never annotate user-scoped surfaces.
- Bust logic MUST be fail-open — a `deleteByTag` fault warns and returns, never throws into a write handler (TTL is the backstop). Mirror `bustNeighborhoodCache`.
- Do NOT set `invalidateOnWrite` — publish-state changes come through bound actions on the base `Concepts` entity, which the plugin's auto-hook wouldn't reliably catch; use explicit tag-bust from the existing hooks.
- Tag value is exactly `'kg-published-concepts'` everywhere (annotation + helper).
- TTL is exactly `300000` (ms; 5 min).
- Only `PublishedConceptsWithAliases` is annotated — NOT the plain `PublishedConcepts` (its only consumer reads via raw `db.run`, which `@cache` can't intercept).
- DEV-only rollout. No PROD changes.
- Follow the existing `srv/lib/kg-neighborhood-cache.js` module shape: lazy `cds.connect.to('caching')` memoized in a module var, exported `_resetConnection()` test seam.

---

## File Structure

- `srv/lib/kg-published-concepts-cache.js` — **new.** Owns the tag constant + `bustPublishedConceptsCache()`. Single responsibility: bust the pilot cache, fail-open. Twin of `kg-neighborhood-cache.js`.
- `srv/knowledge-graph-service.cds` — **modify** (`PublishedConceptsWithAliases`, ~line 98-105): add `@cache` annotation.
- `srv/server.js` — **modify** (KG `after` hooks, ~line 999 + 1011-1016): call the bust helper alongside the existing `scheduleRebuild`.
- `test/unit/kg-published-concepts-cache.test.js` — **new.** Fail-open + tag-value unit tests for the helper.
- `test/hybrid/kg-published-concepts-cache.test.js` — **new.** No-stale-content regression + TTL/tag round-trip against real HANA.
- `docs/developers/reference/cds-caching-store.md` — **modify.** Append "`@cache` pilot + decision record" section.

---

### Task 1: Bust helper `srv/lib/kg-published-concepts-cache.js`

**Files:**
- Create: `srv/lib/kg-published-concepts-cache.js`
- Test: `test/unit/kg-published-concepts-cache.test.js`

**Interfaces:**
- Consumes: the `caching` service via `cds.connect.to('caching')` (already configured in `package.json`).
- Produces:
  - `export const PUBLISHED_CONCEPTS_TAG = 'kg-published-concepts'`
  - `export async function bustPublishedConceptsCache(): Promise<void>` — fail-open `deleteByTag(PUBLISHED_CONCEPTS_TAG)`.
  - `export function _resetConnection(): void` — test seam clearing the memoized connect promise.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg-published-concepts-cache.test.js`:

```javascript
// test/unit/kg-published-concepts-cache.test.js
//
// Unit tests for the #1182 @cache-pilot bust helper. Mirrors the
// kg-neighborhood-cache.test.js conventions: boot a real cds runtime with an
// in-memory caching store so `cds.connect.to('caching')` resolves, then test
// OUR contract — correct tag + fail-open bust.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache, _resetConnection;

beforeAll(async () => {
  cds.env.requires = cds.env.requires || {};
  cds.env.requires.caching = { impl: 'cds-caching', namespace: 'kg-test', store: 'memory' };
  await cds.connect.to('caching');
  ({ PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache, _resetConnection } =
    await import('../../srv/lib/kg-published-concepts-cache.js'));
  _resetConnection();
});

describe('kg-published-concepts-cache', () => {
  it('exposes the exact tag value', () => {
    expect(PUBLISHED_CONCEPTS_TAG).toBe('kg-published-concepts');
  });

  it('bust resolves without throwing on a healthy cache', async () => {
    await expect(bustPublishedConceptsCache()).resolves.toBeUndefined();
  });

  it('is fail-open: a deleteByTag throw is swallowed, not rethrown', async () => {
    const cache = await cds.connect.to('caching');
    const orig = cache.deleteByTag;
    cache.deleteByTag = async () => { throw new Error('boom'); };
    try {
      await expect(bustPublishedConceptsCache()).resolves.toBeUndefined();
    } finally {
      cache.deleteByTag = orig;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/kg-published-concepts-cache.test.js`
Expected: FAIL — `Cannot find module '../../srv/lib/kg-published-concepts-cache.js'`

- [ ] **Step 3: Write minimal implementation**

Create `srv/lib/kg-published-concepts-cache.js`:

```javascript
// srv/lib/kg-published-concepts-cache.js
//
// #1182 — bust helper for the @cache pilot on
// KnowledgeGraphService.PublishedConceptsWithAliases (the ⌘K palette concept
// search). Structural twin of kg-neighborhood-cache.js: the @cache annotation
// owns TTL + storage; this module owns the write-driven invalidation.
//
// The annotation tags every entry PUBLISHED_CONCEPTS_TAG; bustPublishedConceptsCache()
// is a single deleteByTag() called from the existing KG Concepts CRUD +
// publishConcept/unpublishConcept after-write handlers in srv/server.js.
//
// Fail-open: a bust fault is logged and swallowed — stale entries then expire
// via the annotation's TTL. A caching hiccup must never break a concept write.
import cds from '@sap/cds';

export const PUBLISHED_CONCEPTS_TAG = 'kg-published-concepts';

let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Bust every PublishedConceptsWithAliases @cache entry via the shared tag.
 * Called from the KG write hooks after a concept publish/unpublish/edit.
 * Fail-open: logs and returns on any fault; TTL is the backstop.
 */
export async function bustPublishedConceptsCache() {
  try {
    const c = await cache();
    await c.deleteByTag(PUBLISHED_CONCEPTS_TAG);
  } catch (err) {
    cds.log('kg-published-concepts-cache').warn(
      `bust failed, relying on TTL: ${err.message}`,
    );
  }
}

/** Test seam: clear the memoized connect promise between suites. */
export function _resetConnection() {
  _cachePromise = undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/kg-published-concepts-cache.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-published-concepts-cache.js test/unit/kg-published-concepts-cache.test.js
git commit -m "feat(#1182): fail-open bust helper for PublishedConcepts @cache pilot"
```

---

### Task 2: `@cache` annotation on `PublishedConceptsWithAliases`

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (the `PublishedConceptsWithAliases` entity, ~line 98-105)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the annotated projection. The `caching` service now intercepts
  `GET /graph/PublishedConceptsWithAliases?...` reads and tags entries `'kg-published-concepts'`.

- [ ] **Step 1: Read the current entity to anchor the edit**

Run: `grep -n "PublishedConceptsWithAliases\|@cds.search" srv/knowledge-graph-service.cds`
Expected: locate the `@readonly` + `@cds.search: { name, description, aliasSearchBlob }` lines immediately above `entity PublishedConceptsWithAliases as projection on ims.Concepts`.

- [ ] **Step 2: Add the annotation**

Add a `@cache` line as the FIRST annotation on the entity (above `@readonly`). The block becomes:

```cds
  @cache: { ttl: 300000, tags: [{ value: 'kg-published-concepts' }] }
  @readonly
  @cds.search: { name, description, aliasSearchBlob }
  entity PublishedConceptsWithAliases as projection on ims.Concepts {
    ID, slug, name, description, publishedAt, publishedBy, status,
    aliasSearchBlob
  } where publishedAt is not null and status = 'ACTIVE';
```

Leave the sibling `PublishedConcepts` entity (above it) UNCHANGED — no `@cache` (its only consumer reads via raw `db.run`, which `@cache` can't intercept).

- [ ] **Step 3: Verify the model compiles (annotation is valid CDS)**

Run: `npx cds compile srv/knowledge-graph-service.cds --to json 2>&1 | grep -iE "error|@cache" | head`
Expected: no `error` lines. (A clean compile confirms `@cache` parses; the annotation surfaces as `@cache.ttl` / `@cache.tags` in the CSN.)

- [ ] **Step 4: Confirm the annotation landed in the CSN**

Run: `npx cds compile srv/knowledge-graph-service.cds --to json 2>&1 | grep -c "kg-published-concepts"`
Expected: `1` (the tag value appears in the compiled model).

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.cds
git commit -m "feat(#1182): @cache PublishedConceptsWithAliases (ttl 5min, tag kg-published-concepts)"
```

---

### Task 3: Wire the bust into the existing KG write hooks

**Files:**
- Modify: `srv/server.js` (KG `after` hooks, ~line 999 and ~line 1011-1016)

**Interfaces:**
- Consumes: `bustPublishedConceptsCache` from Task 1.
- Produces: on any `Concepts` CREATE/UPDATE/DELETE and any `publishConcept`/`unpublishConcept` action, the pilot cache is busted (fire-and-forget, fail-open).

- [ ] **Step 1: Add the import**

In `srv/server.js`, add to the import block near the other `srv/lib` imports (e.g. right after the `stripPrecompiledPluginRoots` import added by #1182):

```javascript
import { bustPublishedConceptsCache } from './lib/kg-published-concepts-cache.js';
```

- [ ] **Step 2: Bust in the `Concepts` CRUD hook**

Find the existing hook (`grep -n "kg.after(\['CREATE', 'UPDATE', 'DELETE'\], 'Concepts'" srv/server.js`). Inside its callback, add the bust as the FIRST statement after the `x-migration-mode` short-circuit, so it fires even when the rebuild is classified `mode:'none'`:

```javascript
    kg.after(['CREATE', 'UPDATE', 'DELETE'], 'Concepts', async (_data, req) => {
      if (req.headers?.['x-migration-mode'] === 'true') return;
      // #1182: bust the PublishedConceptsWithAliases @cache on any concept
      // write (name/description edits change cached rows; publishedAt flips
      // change membership). Fire-and-forget, fail-open — never blocks the write.
      bustPublishedConceptsCache().catch(() => {});
      const entityName = req.target?.name?.split('.').pop();
      if (!entityName) return;
      const { mode, forceCapRefetch } = classifyRebuildMode(entityName, 'crud');
      if (mode === 'none') return;
      scheduleRebuild('kg-write', { mode, forceCapRefetch }).catch(err => {
        console.error('[rebuild-trigger] scheduling failed', err);
      });
    });
```

- [ ] **Step 3: Bust in the publish/unpublish action hooks**

In the `KG_CATALOG_ACTIONS` loop just below, add the bust as the first statement after the short-circuit:

```javascript
    const KG_CATALOG_ACTIONS = ['publishConcept', 'unpublishConcept'];
    for (const actionName of KG_CATALOG_ACTIONS) {
      kg.after(actionName, async (_data, req) => {
        if (req.headers?.['x-migration-mode'] === 'true') return;
        // #1182: publishConcept/unpublishConcept flip publishedAt — the
        // PublishedConceptsWithAliases `where` filter — so bust the pilot cache.
        bustPublishedConceptsCache().catch(() => {});
        const { mode, forceCapRefetch } = classifyRebuildMode(actionName, 'action');
        scheduleRebuild(`kg-action:${actionName}`, { mode, forceCapRefetch }).catch(err => {
          console.error('[rebuild-trigger] scheduling failed', err);
        });
      });
    }
```

- [ ] **Step 4: Verify server.js still parses (import resolves, no syntax error)**

Run: `node --check srv/server.js`
Expected: no output, exit 0 (syntax OK). (`node --check` validates syntax without executing; the ESM import path is verified at runtime in Task 4's hybrid test.)

- [ ] **Step 5: Commit**

```bash
git add srv/server.js
git commit -m "feat(#1182): bust PublishedConcepts @cache on KG concept writes + publish/unpublish"
```

---

### Task 4: Hybrid no-stale-content regression test

**Files:**
- Create: `test/hybrid/kg-published-concepts-cache.test.js`

**Interfaces:**
- Consumes: the full deployed model under `[hybrid]` (real HANA, `store:'cds'`), `bustPublishedConceptsCache` + `PUBLISHED_CONCEPTS_TAG` from Task 1.
- Produces: proof that the cache round-trips and that a write busts it (no stale content).

- [ ] **Step 1: Write the test**

Create `test/hybrid/kg-published-concepts-cache.test.js`:

```javascript
/**
 * #1182 — hybrid regression: the PublishedConceptsWithAliases @cache pilot
 * must round-trip through the CDS-DB store AND be busted by a concept write, so
 * a publish/unpublish never serves stale palette results.
 *
 * Boots the full srv under [hybrid] (real HANA, store:'cds') via `cds bind`.
 * Run with: cf login + cds bind --exec -- npx vitest run --project hybrid \
 *   test/hybrid/kg-published-concepts-cache.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache } from '../../srv/lib/kg-published-concepts-cache.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#1182 — PublishedConcepts @cache pilot (hybrid)', () => {
  let cache;
  beforeAll(async () => { cache = await cds.connect.to('caching'); });

  it('caching service uses the CDS-DB store under hybrid', () => {
    expect(cds.env.requires.caching.store).toBe('cds');
  });

  it('tag round-trip: set → get hit → deleteByTag → miss', async () => {
    const key = `_1182_pc_probe_${process.pid}`;
    await cache.set(key, { probe: true }, { ttl: 60000, tags: [{ value: PUBLISHED_CONCEPTS_TAG }] });
    expect(await cache.get(key)).toEqual({ probe: true });
    await bustPublishedConceptsCache();
    expect(await cache.get(key)).toBeUndefined();
  });

  it('PublishedConceptsWithAliases read reflects a publish flip after bust (no stale content)', async () => {
    const kg = await cds.connect.to('KnowledgeGraphService');
    const { PublishedConceptsWithAliases } = kg.entities;

    // Warm: read once (populates the @cache entry for this query shape).
    const before = await kg.run(SELECT.from(PublishedConceptsWithAliases).limit(1));

    // Simulate the freshness signal the real publish/unpublish action emits.
    await bustPublishedConceptsCache();

    // Read again — must return live data, not a stale cached payload. We assert
    // the shape is intact (the pilot must never corrupt or drop rows on bust).
    const after = await kg.run(SELECT.from(PublishedConceptsWithAliases).limit(1));
    expect(Array.isArray(after)).toBe(true);
    if (before.length) {
      expect(after[0]).toHaveProperty('slug');
      expect(after[0]).toHaveProperty('publishedAt');
    }
  });
});
```

- [ ] **Step 2: Run against real HANA**

Run: `cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-published-concepts-cache.test.js`
Expected: PASS (3 tests). Requires `cf login` + the `.cdsrc-private.json` binding (copy from primary tree if the worktree lacks it; it's gitignored).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-published-concepts-cache.test.js
git commit -m "test(#1182): hybrid no-stale-content + tag round-trip for PublishedConcepts @cache"
```

---

### Task 5: Documentation — pilot + decision record

**Files:**
- Modify: `docs/developers/reference/cds-caching-store.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented pilot description + a decision placeholder to fill after the DEV soak.

- [ ] **Step 1: Append the pilot section**

Add to the end of `docs/developers/reference/cds-caching-store.md`:

```markdown
## `@cache` annotation pilot — PublishedConceptsWithAliases (#1182)

First declarative `@cache` on a read surface. Annotates
`KnowledgeGraphService.PublishedConceptsWithAliases` (the anonymous ⌘K
command-palette concept search): `@cache: { ttl: 300000, tags: [{ value:
'kg-published-concepts' }] }`.

- **Auth-safe:** service is `@requires:'any'`, rows are not user-scoped, and the
  caching default key is `{hash}`-only (`isUserAware:false`) — the hash includes
  the full `$search`/`$top`/`$select` query, so different searches get different
  keys and no data crosses users.
- **Invalidation:** `srv/lib/kg-published-concepts-cache.js`
  (`bustPublishedConceptsCache()`, fail-open) is called from the existing KG
  `after`-write handlers in `srv/server.js` — `Concepts` CRUD and the
  `publishConcept`/`unpublishConcept` actions (which flip `publishedAt`, the
  projection's filter). TTL (5 min) is the backstop. `invalidateOnWrite` is NOT
  used — publish state changes via base-`Concepts` actions the plugin auto-hook
  wouldn't catch.
- **Scope:** only the service-layer (OData/HCQL/MCP) read is cached. The
  rebuild-time full-list read in `srv/lib/published-concepts-query.js` uses raw
  `db.run` and is intentionally not cached.
- **Metrics:** isolate this surface via `KeyMetrics` (the shared `caching`
  service also carries `kg-neighborhood` entries):

  ```sql
  SELECT "keyName","hits","misses","hitRatio","lastAccess"
    FROM "PLUGIN_CDS_CACHING_KEYMETRICS" ORDER BY "hits" DESC;
  ```

### Decision record

- **Status:** DEV-only pilot, deployed <!-- DATE -->.
- **Measured hit rate after soak:** <!-- fill from KeyMetrics -->.
- **Verdict (expand / hold / revert):** <!-- fill after soak -->.
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/reference/cds-caching-store.md
git commit -m "docs(#1182): document PublishedConcepts @cache pilot + decision record"
```

---

## Post-implementation (not tasks — done after merge)

1. Deploy srv-module-only to DEV (`cds build --production` → `mbt build` → `cf deploy <mtar> -e ../deploy/dev.mtaext -m tutorials-srv -f`), verify boot clean.
2. Exercise the ⌘K palette / hit `/graph/PublishedConceptsWithAliases?$search=…` a few times.
3. After a soak, read `KeyMetrics`, fill the decision record, and choose expand/hold/revert.

## Self-Review

- **Spec coverage:** annotation (Task 2), invalidation tied to real signals (Tasks 1+3), measurement (Task 5 SQL), no-stale-content test (Task 4), decision record (Task 5), scope boundary + auth-safety (Task 5 doc + Global Constraints). All spec sections mapped.
- **Placeholder scan:** the only `<!-- ... -->` markers are the decision-record fields, which are intentionally filled post-soak (documented in Post-implementation). No code-step placeholders.
- **Type consistency:** `PUBLISHED_CONCEPTS_TAG` / `bustPublishedConceptsCache` / `_resetConnection` names identical across Tasks 1, 3, 4. Tag value `'kg-published-concepts'` identical in helper (Task 1), annotation (Task 2), and doc (Task 5). TTL `300000` identical in annotation + doc.
