# Joule External-Content Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Joule find and recommend the 8 external-content types already linked to KG concepts, via a new flag-gated `findRelatedContent` chat tool that reuses the existing cached embed→cosine→walk signal.

**Architecture:** Additively widen the cached `KgSignal` to carry concept IDs, add a UNION fetch helper over the 8 external link tables, wrap them in a new `computeExternalContentSignal` that reuses `computeKgSignal`'s 5-min cache, expose via a new Joule tool + ChatSettings flag, and render results as a new `external-content-cards` SSE event. The tutorial rank blend is left byte-identical.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), HANA + SQLite (dialect-branched raw SQL), Vitest, vanilla JS (joule.js), SAP AI SDK orchestration.

## Global Constraints

- **Never SELECT a HANA NCLOB (`description`) alongside scalar metadata** — LOB locators expire. External cards use `title` + `url` only.
- **HANA branch: all aliases double-quoted lowercase** (`SLUG as "slug"`) per #1113; SQLite branch uses physical lowercase columns, unquoted.
- **Raw `db.run()` with positional `?` placeholders** in `_search-fetches.js` — no `cds.ql` builder mixing.
- **CSV seed for ChatSettings stays empty** — HDI redeploy clobbers admin-editable columns listed in a CSV (`feedback_cap_csv_seeds_clobber_admin_data`).
- **Run `npx cds deploy --to sqlite::memory:`** after editing `db/schema.cds` (runtime `@assert`/deploy check, not just `cds compile`).
- **Run `cds build --production`** after the schema change so it lands in `db/last-dev/`.
- **LLM tool descriptors use OpenAI function-calling shape** (bare `parameters`), NOT Anthropic `input_schema`.
- **Node baseline:** tests run under CI Node 22 + Vitest — avoid Node-24-only idioms; use `cds.entities(NS)` refs over bare projection names.
- **Trust tiers:** `authoritative` = api-doc, help-doc, sample, learning-journey, discovery-mission, video. `community` = blog-post, community-event.
- Work happens on branch `worktree-joule-external-content-1125` (already isolated).

---

## File Structure

- `srv/lib/search-kg-signal.js` — **modify**: add `id` to each `topConcepts` entry (additive).
- `srv/lib/kg/_search-fetches.js` — **modify**: add `fetchExternalContentLinks`.
- `srv/lib/kg/external-content-signal.js` — **create**: `computeExternalContentSignal` + trust-tier/ttl-key maps.
- `db/schema.cds` — **modify**: add `ChatSettings.kgRelatedContentEnabled`.
- `srv/lib/chat-orchestrator.js` — **modify**: tool descriptor, registry + prompt-line wiring, dispatch, SSE emit, export.
- `hugo/static/js/joule.js` — **modify**: `renderExternalContentCards` + SSE switch case.
- `test/unit/kg/_search-fetches.test.js` — **modify**: add `fetchExternalContentLinks` cases.
- `test/unit/search-kg-signal.test.js` — **modify**: assert `topConcepts` carries `id`; assert `buildKgRankFragment` unchanged.
- `test/unit/kg/external-content-signal.test.js` — **create**.
- `test/chat-orchestrator-search-expansion.test.js` — **modify**: add `findRelatedContent` registry/prompt cases.
- `test/hybrid/kg-external-content.test.js` — **create**: HANA-dialect UNION join.

---

## Task 1: Widen cached signal with concept `id`

**Files:**
- Modify: `srv/lib/search-kg-signal.js` (the `topConcepts` map, ~line 361-365)
- Test: `test/unit/search-kg-signal.test.js`

**Interfaces:**
- Consumes: existing `allConcepts` array (each has `.id`, `.slug`, `.name`, `.score`).
- Produces: `signal.topConcepts` entries now shaped `{ id, slug, name, score }` (was `{ slug, name, score }`). Task 3 consumes `id`.

- [ ] **Step 1: Add the failing test**

In `test/unit/search-kg-signal.test.js`, inside the main `describe('search-kg-signal', ...)` block (after the caching tests, ~line 91), add:

```javascript
  it('topConcepts entries carry the concept id (for external-content fetch)', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const s = await computeKgSignal({ phrase: 'async abap', db, embedClient })
    expect(s.topConcepts.length).toBeGreaterThan(0)
    for (const c of s.topConcepts) {
      expect(typeof c.id).toBe('string')
      expect(c.id.length).toBeGreaterThan(0)
    }
    // The seeded concept 'async-abap' must be present by id.
    expect(s.topConcepts.some(c => c.id === 'c-async')).toBe(true)
  })

  it('buildKgRankFragment output is unchanged by the id addition', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const s = await computeKgSignal({ phrase: 'async abap', db, embedClient })
    const frag = buildKgRankFragment(s)
    // Fragment references slugs + numeric scores only — never concept ids.
    expect(frag).not.toMatch(/c-async|c-rap|c-other/)
    expect(frag).toMatch(/when 'abap-async-rap' then/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/search-kg-signal.test.js -t "carry the concept id"`
Expected: FAIL — `c.id` is `undefined` (topConcepts currently omits `id`).

- [ ] **Step 3: Add `id` to the topConcepts map**

In `srv/lib/search-kg-signal.js`, find the `signal` object construction (~line 357-368):

```javascript
      topConcepts: allConcepts.map((c) => ({
        slug: c.slug,
        name: c.name,
        score: Number(c.score.toFixed(4)),
      })),
```

Change to:

```javascript
      topConcepts: allConcepts.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        score: Number(c.score.toFixed(4)),
      })),
```

Also update the `@typedef KgSignal` `topConcepts` JSDoc (~line 122) from
`Array<{slug:string,name:string,score:number}>` to
`Array<{id:string,slug:string,name:string,score:number}>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/search-kg-signal.test.js`
Expected: PASS (all, including the two new cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/search-kg-signal.js test/unit/search-kg-signal.test.js
git commit -m "feat(kg): expose concept id on KgSignal.topConcepts (#1125)"
```

---

## Task 2: `fetchExternalContentLinks` (SQLite + HANA)

**Files:**
- Modify: `srv/lib/kg/_search-fetches.js`
- Test: `test/unit/kg/_search-fetches.test.js`

**Interfaces:**
- Consumes: CDS `db` handle, `conceptIds: string[]`, optional `{ types?: string[] }`.
- Produces: `fetchExternalContentLinks(db, conceptIds, { types } = {}) => Promise<Array<{ content_type, concept_id, slug, title, url, confidence, last_seen_at, end_date }>>`. All keys lowercased regardless of dialect. `content_type` is one of the 8 keys: `learning-journey`, `blog-post`, `discovery-mission`, `video`, `api-doc`, `sample`, `help-doc`, `community-event`. Task 3 consumes this.

- [ ] **Step 1: Write the failing tests**

In `test/unit/kg/_search-fetches.test.js`, add a new `describe` block (import `fetchExternalContentLinks` at top by adding it to the existing import list from `_search-fetches.js`):

```javascript
describe('#1125 fetchExternalContentLinks', () => {
  let db
  const cId = 'ec-concept-1'
  const cId2 = 'ec-concept-2'

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const seen = new Date().toISOString()
    // Concepts (publish-gate columns not required — fetch joins on link tables).
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: cId, slug: 'ai', name: 'AI', status: 'ACTIVE', publishedAt: seen },
      { ID: cId2, slug: 'ml', name: 'ML', status: 'ACTIVE', publishedAt: seen },
    ]))
    // One API doc + link (authoritative), one blog post + link (community).
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-1', slug: 'ad-cap-node', title: 'CAP Node API', url: 'https://api.sap.com/cap', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-1', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPosts').entries([
      { ID: 'bp-1', slug: 'bp-42', title: 'Cool AI post', url: 'https://community.sap.com/bp42', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPostConceptLinks').entries([
      { ID: cds.utils.uuid(), post_ID: 'bp-1', concept_ID: cId, predicate: 'discusses', confidence: 0.6 },
    ]))
    // Community event with endDate (date-aware TTL).
    await db.run(INSERT.into('com.sap.developers.ims.external.CommunityEvents').entries([
      { ID: 'ce-1', slug: 'ce-codejam', title: 'AI CodeJam', url: 'https://events.sap.com/cj', lastSeenAt: seen, startDate: '2026-08-01', endDate: '2026-08-02' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.CommunityEventConceptLinks').entries([
      { ID: cds.utils.uuid(), event_ID: 'ce-1', concept_ID: cId, predicate: 'covers', confidence: 0.7 },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns rows across content types for a matched concept, lowercased keys', async () => {
    const rows = await fetchExternalContentLinks(db, [cId])
    const byType = new Map(rows.map(r => [r.content_type, r]))
    expect(byType.get('api-doc')?.slug).toBe('ad-cap-node')
    expect(byType.get('api-doc')?.url).toBe('https://api.sap.com/cap')
    expect(Number(byType.get('api-doc')?.confidence)).toBeCloseTo(0.9)
    expect(byType.get('blog-post')?.title).toBe('Cool AI post')
    expect(byType.get('community-event')?.end_date).toBeTruthy()
    expect(byType.get('community-event')?.concept_id).toBe(cId)
  })

  it('returns empty array for empty / null conceptIds', async () => {
    expect(await fetchExternalContentLinks(db, [])).toEqual([])
    expect(await fetchExternalContentLinks(db, null)).toEqual([])
  })

  it('types filter restricts which content types are returned', async () => {
    const rows = await fetchExternalContentLinks(db, [cId], { types: ['api-doc'] })
    expect(rows.every(r => r.content_type === 'api-doc')).toBe(true)
    expect(rows.length).toBe(1)
  })

  it('returns nothing for a concept with no external links', async () => {
    const rows = await fetchExternalContentLinks(db, [cId2])
    expect(rows).toEqual([])
  })
})

describe('#1125 fetchExternalContentLinks HANA alias quoting', () => {
  it('HANA branch double-quotes all aliases across every UNION arm', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchExternalContentLinks(db, ['c1'])
    expect(sql).toMatch(/as "content_type"/)
    expect(sql).toMatch(/as "concept_id"/)
    expect(sql).toMatch(/as "slug"/)
    expect(sql).toMatch(/as "title"/)
    expect(sql).toMatch(/as "url"/)
    expect(sql).toMatch(/as "confidence"/)
    expect(sql).toMatch(/as "last_seen_at"/)
    expect(sql).toMatch(/as "end_date"/)
    // All 8 content-type literals present.
    for (const t of ['learning-journey','blog-post','discovery-mission','video','api-doc','sample','help-doc','community-event']) {
      expect(sql).toContain(`'${t}'`)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/kg/_search-fetches.test.js -t "fetchExternalContentLinks"`
Expected: FAIL — `fetchExternalContentLinks is not a function`.

- [ ] **Step 3: Implement `fetchExternalContentLinks`**

In `srv/lib/kg/_search-fetches.js`, append at the end of the file:

```javascript
/**
 * The 8 external-content UNION arms. Each maps a content-type key to its
 * table, link table, link->content FK, and (optionally) an endDate column.
 * `endCol` is null for every type except community-event (only entity with a
 * date-aware TTL). NCLOB `description` is intentionally never selected.
 *
 * #1125. Mirrors the HANA/SQLite dialect branching in fetchLinks.
 */
const EXTERNAL_ARMS = [
  { type: 'learning-journey',  base: 'LearningJourneys',   link: 'LearningJourneyConceptLinks',   fk: 'journey',  endCol: null },
  { type: 'blog-post',         base: 'BlogPosts',          link: 'BlogPostConceptLinks',          fk: 'post',     endCol: null },
  { type: 'discovery-mission', base: 'DiscoveryMissions',  link: 'DiscoveryMissionConceptLinks',  fk: 'mission',  endCol: null },
  { type: 'video',             base: 'Videos',             link: 'VideoConceptLinks',             fk: 'video',    endCol: null },
  { type: 'api-doc',           base: 'ApiDocs',            link: 'ApiDocConceptLinks',            fk: 'apiDoc',   endCol: null },
  { type: 'sample',            base: 'Samples',            link: 'SampleConceptLinks',            fk: 'sample',   endCol: null },
  { type: 'help-doc',          base: 'HelpDocs',           link: 'HelpDocConceptLinks',           fk: 'helpDoc',  endCol: null },
  { type: 'community-event',   base: 'CommunityEvents',    link: 'CommunityEventConceptLinks',    fk: 'event',    endCol: 'endDate' },
]

/**
 * Fetch external-content links for the given concept IDs, UNIONing all 8
 * external link tables back to their content rows. Returns rows shaped
 *   { content_type, concept_id, slug, title, url, confidence, last_seen_at, end_date }
 * with lowercased keys regardless of dialect. `end_date` is null except for
 * community-event rows.
 *
 * @param {object} db          CDS db handle (SQLite or HANA)
 * @param {string[]} conceptIds
 * @param {{types?: string[]}} [opts]  optional content-type allowlist
 * @returns {Promise<Array<object>>}
 */
export async function fetchExternalContentLinks(db, conceptIds, { types } = {}) {
  if (!Array.isArray(conceptIds) || conceptIds.length === 0) return []
  const allow = Array.isArray(types) && types.length ? new Set(types) : null
  const arms = EXTERNAL_ARMS.filter((a) => !allow || allow.has(a.type))
  if (arms.length === 0) return []

  const placeholders = conceptIds.map(() => '?').join(',')

  if (isHana(db)) {
    // HANA: physical table names are UPPERCASE with underscores; aliases
    // double-quoted lowercase so raw rows carry lowercase keys (#1113).
    const selects = arms.map((a) => {
      const baseTbl = `COM_SAP_DEVELOPERS_IMS_EXTERNAL_${a.base.toUpperCase()}`
      const linkTbl = `COM_SAP_DEVELOPERS_IMS_EXTERNAL_${a.link.toUpperCase()}`
      const fkCol = `${a.fk.toUpperCase()}_ID`
      const endExpr = a.endCol ? `b.${a.endCol.toUpperCase()}` : 'NULL'
      return `SELECT '${a.type}' as "content_type", l.CONCEPT_ID as "concept_id",
                     b.SLUG as "slug", b.TITLE as "title", b.URL as "url",
                     l.CONFIDENCE as "confidence", b.LASTSEENAT as "last_seen_at",
                     ${endExpr} as "end_date"
              FROM ${linkTbl} l JOIN ${baseTbl} b ON b.ID = l.${fkCol}
              WHERE l.CONCEPT_ID IN (${placeholders})`
    })
    const params = arms.flatMap(() => conceptIds)
    return await db.run(selects.join('\nUNION ALL\n'), params) || []
  }

  // SQLite: logical table names with dotted namespace; physical lowercase
  // columns. cds.deploy maps `com.sap.developers.ims.external.ApiDocs` to
  // table `com_sap_developers_ims_external_ApiDocs`.
  const selects = arms.map((a) => {
    const baseTbl = `com_sap_developers_ims_external_${a.base}`
    const linkTbl = `com_sap_developers_ims_external_${a.link}`
    const fkCol = `${a.fk}_ID`
    const endExpr = a.endCol ? `b.${a.endCol}` : 'NULL'
    return `SELECT '${a.type}' as content_type, l.concept_ID as concept_id,
                   b.slug as slug, b.title as title, b.url as url,
                   l.confidence as confidence, b.lastSeenAt as last_seen_at,
                   ${endExpr} as end_date
            FROM ${linkTbl} l JOIN ${baseTbl} b ON b.ID = l.${fkCol}
            WHERE l.concept_ID IN (${placeholders})`
  })
  const params = arms.flatMap(() => conceptIds)
  return await db.run(selects.join('\nUNION ALL\n'), params) || []
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/kg/_search-fetches.test.js`
Expected: PASS (all, including new `fetchExternalContentLinks` + HANA-quoting cases).

If the SQLite table name assertion fails, confirm the physical name by running
`npx cds compile db/schema.cds --to sql | grep -i apidocs` and adjust the
`baseTbl`/`linkTbl` prefix to match exactly.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/_search-fetches.js test/unit/kg/_search-fetches.test.js
git commit -m "feat(kg): fetchExternalContentLinks UNION over 8 link tables (#1125)"
```

---

## Task 3: `computeExternalContentSignal`

**Files:**
- Create: `srv/lib/kg/external-content-signal.js`
- Test: `test/unit/kg/external-content-signal.test.js`

**Interfaces:**
- Consumes: `computeKgSignal` (Task 1's `topConcepts[].id`), `fetchExternalContentLinks` (Task 2), `isWithinTTL` from `srv/lib/external-content-ttl.js`.
- Produces: `computeExternalContentSignal({ phrase, db, embedClient, embeddingModel, enabled, timeoutMs, types, maxItems }) => Promise<{ queryEcho, externalContent: Array<{ type, title, url, slug, trustTier, score, rationale }>, warning? }>`. Task 4 consumes this.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/kg/external-content-signal.test.js`:

```javascript
// test/unit/kg/external-content-signal.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'
import { computeExternalContentSignal } from '../../../srv/lib/kg/external-content-signal.js'
import { _resetForTest } from '../../../srv/lib/search-kg-signal.js'

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) { const v = new Array(dims).fill(0); v[i] = 1; return v }

describe('#1125 computeExternalContentSignal', () => {
  let db
  const cId = 'ecs-ai'
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const seen = new Date().toISOString()
    const active = { status: 'ACTIVE', publishedAt: seen, mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: cId, slug: 'ai', name: 'AI', embedding: encode(unit(0)), ...active },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-1', slug: 'ad-cap', title: 'CAP API', url: 'https://api.sap.com/cap', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-1', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPosts').entries([
      { ID: 'bp-1', slug: 'bp-1', title: 'AI blog', url: 'https://community.sap.com/1', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPostConceptLinks').entries([
      { ID: cds.utils.uuid(), post_ID: 'bp-1', concept_ID: cId, predicate: 'discusses', confidence: 0.5 },
    ]))
    // A stale api-doc (lastSeenAt far in the past) — should be TTL-dropped (api-doc TTL 1095 days).
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-stale', slug: 'ad-old', title: 'Old API', url: 'https://api.sap.com/old', lastSeenAt: '2015-01-01T00:00:00Z' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-stale', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })
  beforeEach(() => _resetForTest())

  it('returns ranked external content with trust tiers', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    const bySlug = new Map(out.externalContent.map(e => [e.slug, e]))
    expect(bySlug.get('ad-cap')?.trustTier).toBe('authoritative')
    expect(bySlug.get('ad-cap')?.type).toBe('api-doc')
    expect(bySlug.get('bp-1')?.trustTier).toBe('community')
    // score = conceptScore(=1 for exact cosine) * confidence
    expect(bySlug.get('ad-cap')?.score).toBeGreaterThan(bySlug.get('bp-1')?.score)
    expect(bySlug.get('ad-cap')?.rationale).toMatch(/AI/)
  })

  it('drops TTL-expired rows (stale api-doc absent)', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    expect(out.externalContent.some(e => e.slug === 'ad-old')).toBe(false)
  })

  it('honors maxItems cap', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient, maxItems: 1 })
    expect(out.externalContent.length).toBe(1)
  })

  it('honors types filter', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient, types: ['api-doc'] })
    expect(out.externalContent.every(e => e.type === 'api-doc')).toBe(true)
  })

  it('reuses the shared cache — one embed across two calls', async () => {
    const embed = vi.fn(async () => Float32Array.from(unit(0)))
    const embedClient = { embed }
    await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('propagates kg_empty warning with empty content', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'x', db: empty, embedClient })
    expect(out.warning).toBe('kg_empty')
    expect(out.externalContent).toEqual([])
  })

  it('empty phrase returns empty without embedding', async () => {
    const embed = vi.fn()
    const out = await computeExternalContentSignal({ phrase: '  ', db, embedClient: { embed } })
    expect(out.externalContent).toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/kg/external-content-signal.test.js`
Expected: FAIL — module not found / `computeExternalContentSignal is not a function`.

- [ ] **Step 3: Implement the module**

Create `srv/lib/kg/external-content-signal.js`:

```javascript
// srv/lib/kg/external-content-signal.js
//
// #1125: external-content retrieval signal for Joule's findRelatedContent tool.
// Reuses computeKgSignal (search-kg-signal.js) — its 5-min LRU + single-flight
// means a findRelatedContent call in the same turn as searchTutorials /
// expandSearchConcepts pays ZERO extra embed. Takes the gated concept set +
// per-concept scores, fetches external links across all 8 link tables, applies
// the same isWithinTTL freshness gate the RDF projection uses, aggregates
// Σ(conceptScore × linkConfidence) per content item, tags each with a trust
// tier, sorts, and caps.
//
// This module NEVER perturbs the tutorial rank blend — it only reads the
// already-computed topConcepts from the shared signal.

import { computeKgSignal } from '../search-kg-signal.js'
import { fetchExternalContentLinks } from './_search-fetches.js'
import { isWithinTTL } from '../external-content-ttl.js'
import cds from '@sap/cds'

const LOG = cds.log('external-content-signal')

const DEFAULT_MAX_ITEMS = 8
const HARD_QUERY_LIMIT = 200

// content_type → trust tier. Community = arbitrary-author / time-sensitive.
const TRUST_TIER = Object.freeze({
  'learning-journey': 'authoritative',
  'blog-post': 'community',
  'discovery-mission': 'authoritative',
  'video': 'authoritative',
  'api-doc': 'authoritative',
  'sample': 'authoritative',
  'help-doc': 'authoritative',
  'community-event': 'community',
})

// content_type is already the PER_TYPE_TTL_DAYS key — the fetch helper emits
// the same kebab keys the TTL table is keyed on, so this is an identity lookup
// guarded to only known types.
function ttlKeyFor(contentType) {
  return contentType in TRUST_TIER ? contentType : null
}

/**
 * @param {object} opts
 * @param {string} opts.phrase
 * @param {object} opts.db
 * @param {object=} opts.embedClient
 * @param {string=} opts.embeddingModel
 * @param {boolean=} opts.enabled
 * @param {number=} opts.timeoutMs
 * @param {string[]=} opts.types
 * @param {number=} opts.maxItems
 * @returns {Promise<{queryEcho:string, externalContent:Array, warning?:string}>}
 */
export async function computeExternalContentSignal({
  phrase, db, embedClient, embeddingModel,
  enabled = true, timeoutMs, types, maxItems = DEFAULT_MAX_ITEMS,
}) {
  const rawQuery = typeof phrase === 'string' ? phrase.trim() : ''
  if (!rawQuery) return { queryEcho: '', externalContent: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) {
    return { queryEcho: rawQuery, externalContent: [], warning: 'query_too_long' }
  }

  const signal = await computeKgSignal({
    phrase: rawQuery, db, embedClient, embeddingModel, enabled, timeoutMs,
  })

  if (signal.warning) {
    return { queryEcho: rawQuery, externalContent: [], warning: signal.warning }
  }
  const concepts = Array.isArray(signal.topConcepts) ? signal.topConcepts : []
  if (concepts.length === 0) {
    return { queryEcho: rawQuery, externalContent: [] }
  }

  const conceptScoreById = new Map(concepts.map((c) => [c.id, c.score]))
  const conceptNameById = new Map(concepts.map((c) => [c.id, c.name]))

  let rows
  try {
    rows = await fetchExternalContentLinks(db, concepts.map((c) => c.id), { types })
  } catch (err) {
    LOG.warn('fetchExternalContentLinks failed', err.message)
    return { queryEcho: rawQuery, externalContent: [], warning: 'db_error' }
  }

  // Aggregate per content item (keyed by content_type + slug).
  const byItem = new Map()
  for (const r of rows) {
    const ttlKey = ttlKeyFor(r.content_type)
    if (!ttlKey) continue
    if (!isWithinTTL(ttlKey, r.last_seen_at, r.end_date ?? null)) continue
    const cs = conceptScoreById.get(r.concept_id) ?? 0
    const contribution = cs * (Number(r.confidence) || 0)
    const key = `${r.content_type}::${r.slug}`
    let bucket = byItem.get(key)
    if (!bucket) {
      bucket = {
        type: r.content_type, title: r.title, url: r.url, slug: r.slug,
        trustTier: TRUST_TIER[r.content_type], score: 0, contribs: [],
      }
      byItem.set(key, bucket)
    }
    bucket.score += contribution
    bucket.contribs.push({ conceptId: r.concept_id, contribution })
  }

  const externalContent = [...byItem.values()]
    .map((b) => {
      const top = b.contribs
        .sort((x, y) => y.contribution - x.contribution)
        .slice(0, 2)
        .map((c) => conceptNameById.get(c.conceptId))
        .filter(Boolean)
      const rationale = top.length === 0 ? ''
        : top.length === 1 ? `Related to ${top[0]}`
        : `Related to ${top[0]} and ${top[1]}`
      return {
        type: b.type, title: b.title, url: b.url, slug: b.slug,
        trustTier: b.trustTier, score: Number(b.score.toFixed(4)), rationale,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)

  return { queryEcho: rawQuery, externalContent }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/kg/external-content-signal.test.js`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/external-content-signal.js test/unit/kg/external-content-signal.test.js
git commit -m "feat(kg): computeExternalContentSignal with TTL gate + trust tiers (#1125)"
```

---

## Task 4: ChatSettings flag + tool descriptor + registry/prompt wiring

**Files:**
- Modify: `db/schema.cds` (ChatSettings, after `searchKgRerankEnabled` ~line 655)
- Modify: `srv/lib/chat-orchestrator.js`
- Test: `test/chat-orchestrator-search-expansion.test.js`

**Interfaces:**
- Consumes: `buildToolRegistry`, `buildSystemPromptLines` (existing exports).
- Produces: `FIND_RELATED_CONTENT_TOOL` descriptor + `kgRelatedContentEnabled` gating. Task 5 consumes the descriptor name `findRelatedContent` in dispatch/SSE.

- [ ] **Step 1: Add the failing registry/prompt tests**

In `test/chat-orchestrator-search-expansion.test.js`, add a new describe block:

```javascript
describe('#1125 findRelatedContent gating', () => {
  it('registers findRelatedContent when kgRelatedContentEnabled=true', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(true);
  });
  it('omits findRelatedContent when kgRelatedContentEnabled=false', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: false } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('omits findRelatedContent on devtoberfest pages regardless of flag', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true }, pageContext: { kind: 'devtoberfest' } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('omits findRelatedContent on advocates pages regardless of flag', () => {
    const tools = buildToolRegistry({ settings: { kgRelatedContentEnabled: true }, pageContext: { kind: 'advocates' } });
    expect(tools.some(t => t.function?.name === 'findRelatedContent')).toBe(false);
  });
  it('adds a system-prompt line when flag on, none when off', () => {
    const on = buildSystemPromptLines({ settings: { kgRelatedContentEnabled: true } });
    expect(on.some(l => /findRelatedContent/.test(l))).toBe(true);
    const off = buildSystemPromptLines({ settings: { kgRelatedContentEnabled: false } });
    expect(off.some(l => /findRelatedContent/.test(l))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/chat-orchestrator-search-expansion.test.js -t "findRelatedContent gating"`
Expected: FAIL — tool never registered.

- [ ] **Step 3: Add the ChatSettings flag**

In `db/schema.cds`, inside `entity ChatSettings`, after the `searchKgRerankEnabled` field (~line 655), add:

```cds
  // Knowledge Graph external-content recommendation tool (#1125). When true,
  // findRelatedContent is registered on the standard learner/admin path. Reuses
  // the same cached embed+cosine as kgSearchExpansionEnabled, then fans out over
  // the 8 external-content link tables (bounded by the <=5 concept set). Default
  // true (cheap, cache-reused); toggle off if telemetry shows problems.
  kgRelatedContentEnabled : Boolean default true;
```

- [ ] **Step 4: Verify schema deploys**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no error (in-memory deploy succeeds — catches `@assert`/runtime issues).

- [ ] **Step 5: Add the tool descriptor + wiring**

In `srv/lib/chat-orchestrator.js`, after the `EXPAND_SEARCH_CONCEPTS_TOOL` import usages / near the other tool constants (e.g. after `GET_DEVTOBERFEST_INFO_TOOL`, ~line 218), add:

```javascript
const FIND_RELATED_CONTENT_TOOL = {
  type: 'function',
  function: {
    name: 'findRelatedContent',
    description: [
      'Find SAP external content (learning journeys, blog posts, Discovery',
      'Center missions, videos, API docs, code samples, help docs, community',
      'events) related to a topic, via the knowledge graph.',
      'Use when the user asks for docs, videos, samples, blogs, learning',
      'journeys, events, or "external content / resources" on a topic.',
      'Authoritative items (SAP-authored docs/samples/videos/journeys/missions)',
      'may be cited directly; community items (blog posts, events) should be',
      'presented with soft attribution.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text topic. 1-200 chars.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: [
            'learning-journey', 'blog-post', 'discovery-mission', 'video',
            'api-doc', 'sample', 'help-doc', 'community-event',
          ] },
          description: 'Optional: restrict to these content types.',
        },
        maxItems: { type: 'integer', description: 'Cap on returned items. 1-20, default 8.' },
      },
      required: ['query'],
    },
  },
};
```

In `buildToolRegistry`, after the `kgSearchExpansionEnabled` block (~line 275-277):

```javascript
  if (settings?.kgRelatedContentEnabled) {
    tools.push(FIND_RELATED_CONTENT_TOOL);
  }
```

In `buildSystemPromptLines`, after the `kgSearchExpansionEnabled` block (~line 296):

```javascript
  if (settings?.kgRelatedContentEnabled) {
    lines.push(
      "When the user asks for external content — docs, videos, code samples, blog posts, learning journeys, Discovery missions, or community events on a topic — call `findRelatedContent`. Cite authoritative items (SAP-authored docs, samples, videos, journeys, missions) directly; present community items (blog posts, events) with soft attribution like \"a community blog post by …\"."
    );
  }
```

Add `FIND_RELATED_CONTENT_TOOL` to the final `export { ... }` list (~line 789).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/chat-orchestrator-search-expansion.test.js`
Expected: PASS (existing + new `findRelatedContent gating`).

- [ ] **Step 7: Commit**

```bash
git add db/schema.cds srv/lib/chat-orchestrator.js test/chat-orchestrator-search-expansion.test.js
git commit -m "feat(chat): findRelatedContent tool descriptor + kgRelatedContentEnabled flag (#1125)"
```

---

## Task 5: Dispatch + SSE emit

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (`dispatchTool`, `streamChat` post-dispatch)
- Test: `test/chat-orchestrator-search-expansion.test.js` (dispatch unit) OR a focused new test file.

**Interfaces:**
- Consumes: `computeExternalContentSignal` (Task 3), `FIND_RELATED_CONTENT_TOOL` (Task 4), `resolveEmbeddingSettings`, `defaultEmbedClient` (existing).
- Produces: `dispatchTool('findRelatedContent', args, user) => { queryEcho, externalContent, warning? }`; SSE `{ type:'external-content-cards', items }`.

- [ ] **Step 1: Write the failing dispatch test**

Add to `test/chat-orchestrator-search-expansion.test.js` (import `dispatchTool` from the orchestrator if not already imported):

```javascript
import { dispatchTool } from '../srv/lib/chat-orchestrator.js';

describe('#1125 dispatchTool findRelatedContent', () => {
  it('returns an empty-content envelope for an empty query without throwing', async () => {
    const out = await dispatchTool('findRelatedContent', { query: '   ' }, { id: 'u1' });
    expect(out).toHaveProperty('externalContent');
    expect(Array.isArray(out.externalContent)).toBe(true);
    expect(out.externalContent).toEqual([]);
  });
});
```

> Note: this exercises the empty-query short-circuit, which needs no DB/AI. A
> full happy-path dispatch is covered by the hybrid test (Task 7) where a real
> `db` + embed client exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat-orchestrator-search-expansion.test.js -t "dispatchTool findRelatedContent"`
Expected: FAIL — returns `{ error: 'unknown_tool' }`.

- [ ] **Step 3: Add the dispatch branch**

In `srv/lib/chat-orchestrator.js` `dispatchTool`, after the `expandSearchConcepts` branch (~line 617, before `return { error: 'unknown_tool' }`):

```javascript
  if (name === 'findRelatedContent') {
    try {
      if (typeof args?.query !== 'string' || !args.query.trim()) {
        return { queryEcho: '', externalContent: [] };
      }
      const db = await cds.connect.to('db');
      const { model } = await resolveEmbeddingSettings();
      const embedClient = defaultEmbedClient(model);
      const { computeExternalContentSignal } = await import('./kg/external-content-signal.js');
      const maxItems = typeof args?.maxItems === 'number' ? args.maxItems : undefined;
      const types = Array.isArray(args?.types) ? args.types : undefined;
      return await computeExternalContentSignal({
        phrase: args.query, db, embedClient, embeddingModel: model,
        enabled: true, types, maxItems,
      });
    } catch (err) {
      LOG.warn('findRelatedContent dispatch failed:', err.message);
      return { queryEcho: args?.query ?? '', externalContent: [], warning: 'dispatch_failed' };
    }
  }
```

- [ ] **Step 4: Add the SSE emit branch**

In `streamChat`, in the post-dispatch `if/else if` chain (~line 738-750), add after the `searchTutorials` tutorial-cards branch:

```javascript
        } else if (tc.name === 'findRelatedContent' && result && Array.isArray(result.externalContent) && result.externalContent.length > 0) {
          sse(res, { type: 'external-content-cards', items: result.externalContent });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/chat-orchestrator-search-expansion.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-search-expansion.test.js
git commit -m "feat(chat): dispatch findRelatedContent + external-content-cards SSE (#1125)"
```

---

## Task 6: Frontend renderer

**Files:**
- Modify: `hugo/static/js/joule.js` (`renderExternalContentCards` + SSE switch ~line 646)

**Interfaces:**
- Consumes: SSE payload `{ type:'external-content-cards', items:[{ type, title, url, slug, trustTier, score, rationale }] }`.
- Produces: DOM cards with external anchors.

- [ ] **Step 1: Add the renderer function**

In `hugo/static/js/joule.js`, after `renderStepCitations` (~line 238), add:

```javascript
  function safeExternalHref(url) {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch { return null; }
  }

  const EXTERNAL_TYPE_LABELS = {
    'learning-journey': 'Learning Journey',
    'blog-post': 'Blog Post',
    'discovery-mission': 'Discovery Mission',
    'video': 'Video',
    'api-doc': 'API Doc',
    'sample': 'Code Sample',
    'help-doc': 'Help Doc',
    'community-event': 'Community Event',
  };

  function renderExternalContentCards(items) {
    const wrap = document.createElement('div');
    wrap.className = 'joule-external-content';
    const heading = document.createElement('p');
    heading.className = 'joule-external-content__heading';
    heading.textContent = 'Related content';
    wrap.appendChild(heading);
    const ul = document.createElement('ul');
    for (const it of items) {
      if (!it || typeof it.url !== 'string') continue;
      const href = safeExternalHref(it.url);
      if (!href) continue;
      const li = document.createElement('li');
      li.className = 'joule-external-content__item';

      const label = document.createElement('span');
      label.className = 'joule-external-content__type';
      label.textContent = EXTERNAL_TYPE_LABELS[it.type] || it.type || 'Resource';
      li.appendChild(label);

      const a = document.createElement('a');
      a.className = 'joule-external-content__link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = it.title || it.slug || href;
      li.appendChild(a);

      if (it.trustTier === 'community') {
        const tier = document.createElement('span');
        tier.className = 'joule-external-content__tier';
        tier.textContent = ' (community)';
        li.appendChild(tier);
      }
      ul.appendChild(li);
    }
    if (ul.childElementCount > 0) {
      wrap.appendChild(ul);
      transcript.appendChild(wrap);
      scrollToBottom(body);
    }
  }
```

- [ ] **Step 2: Wire the SSE case**

In the SSE payload handler (~line 646-656), after the `doc-citations` / `step-citations` branches, add:

```javascript
          } else if (payload.type === 'external-content-cards') {
            renderExternalContentCards(payload.items || []);
```

- [ ] **Step 3: Manually verify the syntax (no JS test harness for joule.js)**

Run: `node --check hugo/static/js/joule.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): render external-content-cards SSE as external links (#1125)"
```

---

## Task 7: Hybrid test (HANA dialect + real joins)

**Files:**
- Create: `test/hybrid/kg-external-content.test.js`

**Interfaces:**
- Consumes: `fetchExternalContentLinks`, `computeExternalContentSignal` against real HANA via `cds bind`.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/kg-external-content.test.js` (mirror the structure of `test/hybrid/kg-search-expansion.test.js` — read that file first for the exact bootstrap/harness idiom used in this repo, e.g. `cds.test`, `--project hybrid`, and how it acquires `db`):

```javascript
// test/hybrid/kg-external-content.test.js
// #1125 — exercises the _search-fetches.js HANA branch (unit-untestable) and
// the end-to-end external-content signal against a real HANA binding.
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { fetchExternalContentLinks } from '../../srv/lib/kg/_search-fetches.js'

describe('#1125 external content — HANA dialect', () => {
  let db
  beforeAll(async () => { db = await cds.connect.to('db') })

  it('fetchExternalContentLinks returns lowercased-key rows for a known concept', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const [c] = await db.run(SELECT.from(Concepts).columns('ID').limit(1))
    if (!c) return // empty KG — nothing to assert
    const rows = await fetchExternalContentLinks(db, [c.ID])
    for (const r of rows) {
      expect(r).toHaveProperty('content_type')
      expect(r).toHaveProperty('concept_id')
      expect(r).toHaveProperty('slug')
      expect(r).toHaveProperty('url')
      // Keys must be lowercase (HANA folds unquoted aliases upper — #1113).
      expect(r).not.toHaveProperty('CONTENT_TYPE')
    }
  })
})
```

- [ ] **Step 2: Run the hybrid test (requires cf login + cds bind)**

Run: `npx vitest run test/hybrid/kg-external-content.test.js --project hybrid`
Expected: PASS (or graceful no-op when KG is empty). If it can't connect, note that hybrid requires `cf login` + a bound HANA — the CI hybrid job runs it.

> **Constraint reminder:** never run bare `vitest <file>` for hybrid — the
> `--project hybrid` flag is what loads the hybrid setup (memory:
> `bare vitest silently skips hybrid setup`).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-external-content.test.js
git commit -m "test(kg): hybrid HANA-dialect coverage for external content (#1125)"
```

---

## Task 8: Full-suite verification + production build

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS. If any pre-existing tests reference `topConcepts` shape or ChatSettings columns, confirm they still pass (the `id` addition is additive; the flag defaults true).

- [ ] **Step 2: Regenerate production CDS build (schema changed)**

Run: `cds build --production`
Expected: succeeds; `db/last-dev/csn.json` updated to include `kgRelatedContentEnabled`.

- [ ] **Step 3: Commit the build artifacts**

```bash
git add db/last-dev/ gen/ 2>/dev/null; git add -A
git commit -m "chore(build): regenerate production CDS build for kgRelatedContentEnabled (#1125)"
```

> If `cds build --production` produces no tracked changes in this repo layout,
> skip the commit — confirm with `git status` first.

- [ ] **Step 4: Push branch + open draft PR**

```bash
git push -u origin worktree-joule-external-content-1125
gh pr create --draft --title "feat(kg): Joule external-content retrieval (#1125)" \
  --body "Implements #1125 per docs/superpowers/specs/2026-07-12-1125-joule-external-content-design.md. Widens KG retrieval so Joule can recommend the 8 external-content types via a new flag-gated findRelatedContent tool. Tutorial rank blend untouched (additive topConcepts.id only)."
```

---

## Self-Review

**Spec coverage:**
- A1 widen signal → Task 1 ✓
- A2 fetch helper → Task 2 ✓
- A3 signal module (cache reuse, TTL gate, trust tiers, aggregation, cap) → Task 3 ✓
- B1 ChatSettings flag → Task 4 ✓
- B2 tool descriptor + registry + dispatch → Tasks 4 & 5 ✓
- B3 system-prompt line → Task 4 ✓
- B4 SSE emit → Task 5 ✓
- B5 frontend renderer (external anchors, url sanitize, group by type, community hint) → Task 6 ✓
- Testing: unit (Tasks 1-5), hybrid (Task 7), full suite + prod build (Task 8) ✓
- Rollout: `cds deploy` check (Task 4 Step 4), `cds build --production` (Task 8) ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 7 references reading `kg-search-expansion.test.js` for the exact harness idiom — that's a direct pointer to an existing file, not a placeholder (the repo's hybrid bootstrap varies and must be matched, not invented).

**Type consistency:**
- `topConcepts[].id` produced in Task 1, consumed in Task 3 ✓
- `fetchExternalContentLinks(db, conceptIds, {types})` → rows `{ content_type, concept_id, slug, title, url, confidence, last_seen_at, end_date }` produced in Task 2, consumed in Task 3 ✓
- `computeExternalContentSignal(...) => { queryEcho, externalContent: [{type,title,url,slug,trustTier,score,rationale}], warning? }` produced Task 3, consumed Tasks 5 (dispatch) & 6 (renderer fields) ✓
- Tool name `findRelatedContent` consistent across Tasks 4/5/6 ✓
- SSE `external-content-cards` consistent across Tasks 5/6 ✓
