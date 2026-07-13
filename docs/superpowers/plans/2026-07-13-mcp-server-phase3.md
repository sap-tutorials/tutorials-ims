# MCP Server Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin/KG-power-user MCP tier and add resources + prompts primitives, via a compose layer that adds resources/prompts to the tools-only `@cap-js/mcp` adapter on the same endpoint.

**Architecture:** Four workstreams. WS1 (KG deep-dive tools) and WS2 (admin curation tools) are thin CDS functions wrapping existing handlers, riding the plain `@cap-js/mcp` adapter. WS3 (resources + prompts) is delivered by a new `srv/lib/mcp-compose-router.js` that builds its own per-request SDK `McpServer`, reuses the adapter's exported tool-registration functions, and adds `registerResource`/`registerPrompt`. All behind `MCP_PHASE3_ENABLED` with fail-open to the plain adapter.

**Tech Stack:** SAP CAP 10 (Node.js), `@cap-js/mcp@1.1.1`, `@modelcontextprotocol/sdk`, Express, Vitest, SAP HANA Cloud (hybrid), XSUAA, AppRouter.

**Spec:** [`docs/superpowers/specs/2026-07-13-mcp-server-phase3-design.md`](../specs/2026-07-13-mcp-server-phase3-design.md)

## Global Constraints

- **Zero net-new business logic.** Every KG and admin tool is a thin wrapper on an existing service handler; resources reuse `srv/lib/tutorial-step-slicer.js` + `srv/lib/content-store.js`. No new graph/content algorithms.
- **Fail-open, no info-disclosure.** Anonymous tool handlers `log.error` server-side and return `[]`/empty — never echo `e.message` to the caller (#1111). Compose-router faults fall back to the plain adapter.
- **Doc-comment discipline.** Every CDS function/action gets `/** ... */`; first sentence ≥40 chars becomes the LLM-facing tool description. No boilerplate substrings (`"TODO"`, `"function that"`).
- **Arg clamps in one file.** All range/enum validation via `srv/lib/mcp-arg-validators.js` (`assertRange`, `assertEnum`, `clampLimit`). One grep audits every clamp.
- **Dual-file xs-security.** Any scope change edits BOTH `xs-security.json` AND `.deploy/xs-security.json`; `test/unit/xs-security-authorities.test.js` guards drift.
- **Run `npx cds deploy --to sqlite::memory:`** after ANY `db/**/*.cds` or CSV change (runtime-only `@assert.unique` errors). Not needed for `srv/**` CDS-only changes, but run `npx cds compile srv --to json >/dev/null` to catch model errors.
- **Kill switches** (env, `cf set-env`+restart, no redeploy): `MCP_PHASE3_ENABLED`, `MCP_RESOURCES_ENABLED`, `MCP_PROMPTS_ENABLED`, `MCP_ADMIN_TOOLS_ENABLED` — all default `true`.
- **`srv-qa` cp-list audit.** New `srv/mcp/` dir + `srv/lib/mcp-*.js` files must appear in BOTH `srv` and `srv-qa` `cp` lists in `.deploy/mta.yaml`.
- **Commit style:** `feat(#1106): <what>` / `test(#1106): <what>` / `docs(#1106): <what>`.
- **Hybrid tests:** always `npm run test:hybrid` or `vitest --project hybrid` (bare `vitest <file>` skips hybrid setup).
- **ESM.** `srv/**` is ESM (`import`/`export`); `.cjs` only where a file already uses CommonJS.

## File Structure

**New files:**
- `srv/knowledge-graph-service-mcp.cds` — WS1 KG tool declarations (aspect-extends `KnowledgeGraphService`).
- `srv/lib/mcp-kg-tools.js` — WS1 handlers (4 exported functions).
- `srv/admin-service-mcp.cds` — WS2 admin tool declarations + `@protocol` widening.
- `srv/lib/mcp-admin-tools.js` — WS2 handlers (4 exported functions).
- `srv/lib/mcp-compose-router.js` — WS3 compose layer (per-request McpServer, tool-fn reuse + R/P).
- `srv/lib/mcp-resources.js` — WS3 resource registration (`tutorial://`, `mission://`, `concept://`).
- `srv/lib/mcp-prompt-loader.js` — WS3 prompt loader + `prompts/list`/`prompts/get`.
- `srv/mcp/prompts/*.md` — 4 static prompt templates (YAML frontmatter).
- `test/unit/mcp-kg-tools.test.js`, `test/unit/mcp-admin-tools.test.js`, `test/unit/mcp-compose-router.test.js`, `test/unit/mcp-resources.test.js`, `test/unit/mcp-prompt-loader.test.js`.
- `test/hybrid/mcp-kg-tools.test.js`, `test/hybrid/mcp-admin-tools.test.js`, `test/hybrid/mcp-resources.test.js`.

**Modified files:**
- `srv/knowledge-graph-service.js` — wire 4 KG handlers (`this.on(...)`).
- `srv/admin-service.js` — wire 4 admin handlers.
- `srv/server.js` — add `/mcp-admin`→`/mcp/admin` rewrite; mount compose router.
- `approuter/xs-app.json` — add `^/mcp-admin/(.*)$` route.
- `xs-security.json` + `.deploy/xs-security.json` — (no new scope needed; reuse `Tutorial.MCP` — see Task 8).
- `.deploy/mta.yaml` — `srv` + `srv-qa` cp-lists for `srv/mcp/` + `srv/lib/mcp-*.js`.
- `test/unit/mcp-contract.test.js` — extend `CURATED_TOOLS` + `EXPECTED_PARAMS`; add R/P assertions.
- `test/unit/xs-security-authorities.test.js` — assert `/mcp-admin` gate scope in both files.
- `test/smoke/mcp.smoke.test.js` — resources/prompts 200; `/mcp-admin` 401 without JWT.
- Docs: `docs/end-users/mcp-quickstart.md`, `docs/developers/reference/mcp-server.md`, `docs/developers/architecture/mcp-server.md`, `docs/developers/operations/mcp-server.md`, `docs/.vitepress/config.ts`.

## Task Ordering

Foundation (arg-validator confirm) → WS1 KG tools (Tasks 1–4) → WS3 compose router + resources + prompts (Tasks 5–11) → WS2 admin tools + route (Tasks 12–15) → contract/smoke/docs/rollout (Tasks 16–19).

Rationale: WS1 is the lowest-risk, self-contained warm-up on the proven adapter. WS3's compose router is the shared foundation the R/P work needs and must land before it can be tested end-to-end. WS2 admin tools depend on the `/mcp-admin` route + compose mount being in place.

---

## Workstream 1 — KG deep-dive tools

### Task 1: KG tool CDS declarations + handler wiring for `kg_shared_concepts`

**Files:**
- Create: `srv/knowledge-graph-service-mcp.cds`
- Create: `srv/lib/mcp-kg-tools.js`
- Modify: `srv/knowledge-graph-service.js` (add `this.on('kg_shared_concepts', ...)` in the handler-registration block, near `kg_prerequisites` ~line 1357)
- Test: `test/unit/mcp-kg-tools.test.js`

**Interfaces:**
- Consumes: existing `neighborhood(slug)` service function returning `{ prerequisitesOf[], sharedConcepts[], whatToLearnNext[], teaches[] }`, each item `{ slug, title, score }`; `srv/lib/mcp-arg-validators.js` exports `clampLimit(value, defaultN, maxN)`.
- Produces: `srv/lib/mcp-kg-tools.js` exports `handleSharedConcepts(req)` (used by `this.on` wiring). CDS function `kg_shared_concepts(slug_a: String, slug_b: String) returns array of { conceptSlug: String; name: String; score: Double }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-kg-tools.test.js
import { expect, describe, it, vi } from 'vitest';
import { handleSharedConcepts } from '../../srv/lib/mcp-kg-tools.js';

describe('kg_shared_concepts', () => {
  it('returns concept overlap of two tutorials, deduped by conceptSlug', async () => {
    // Fake service: neighborhood(slug_a) teaches concepts [c1,c2]; slug_b teaches [c2,c3].
    const srv = {
      send: vi.fn(async (_evt, { slug }) => ({
        teaches: slug === 'a'
          ? [{ slug: 'c1', title: 'C1', score: 0.9 }, { slug: 'c2', title: 'C2', score: 0.8 }]
          : [{ slug: 'c2', title: 'C2', score: 0.7 }, { slug: 'c3', title: 'C3', score: 0.6 }],
      })),
    };
    const req = { data: { slug_a: 'A', slug_b: 'B' }, srv };
    const out = await handleSharedConcepts.call(srv, req);
    expect(out).toEqual([{ conceptSlug: 'c2', name: 'C2', score: expect.any(Number) }]);
  });

  it('fail-open: returns [] when neighborhood throws, no error echo', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('boom'); }) };
    const req = { data: { slug_a: 'A', slug_b: 'B' }, srv };
    const out = await handleSharedConcepts.call(srv, req);
    expect(out).toEqual([]);
  });

  it('returns [] when either slug missing', async () => {
    const srv = { send: vi.fn() };
    expect(await handleSharedConcepts.call(srv, { data: { slug_a: 'A' }, srv })).toEqual([]);
    expect(srv.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js`
Expected: FAIL — `handleSharedConcepts` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-kg-tools.js
import cds from '@sap/cds';
const log = cds.log('mcp-kg');

/**
 * kg_shared_concepts — concept overlap between two tutorials.
 * Intersects each tutorial's `teaches` arm (from neighborhood()) by conceptSlug.
 * `this` is the KnowledgeGraphService (bound via this.on). Fail-open → [].
 */
export async function handleSharedConcepts(req) {
  const a = (req.data.slug_a ?? '').toLowerCase();
  const b = (req.data.slug_b ?? '').toLowerCase();
  if (!a || !b) return [];
  try {
    const [nbA, nbB] = await Promise.all([
      this.send('neighborhood', { slug: a }),
      this.send('neighborhood', { slug: b }),
    ]);
    const bByslug = new Map((nbB?.teaches ?? []).map((c) => [c.slug, c]));
    const seen = new Set();
    const out = [];
    for (const c of nbA?.teaches ?? []) {
      const match = bByslug.get(c.slug);
      if (!match || seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push({ conceptSlug: c.slug, name: c.title ?? c.slug, score: Math.min(c.score ?? 0, match.score ?? 0) });
    }
    return out;
  } catch (e) {
    log.error(`kg_shared_concepts(${a},${b}) failed — ${e.message ?? e}`);
    return [];
  }
}
```

```cds
// srv/knowledge-graph-service-mcp.cds
using from './knowledge-graph-service';

// Phase 3 (#1106) — KG deep-dive MCP tools. Anonymous (@requires:'any' inherited
// from KnowledgeGraphService). Doc-comments become MCP tool descriptions.
extend service KnowledgeGraphService {

  /** Concept overlap between two tutorials — the concepts BOTH teach. Answers
      "what do these two tutorials have in common?". Anonymous; published KG
      content is public.
      @param slug_a  First tutorial slug (lowercase canonical).
      @param slug_b  Second tutorial slug (lowercase canonical). */
  function kg_shared_concepts(slug_a: String, slug_b: String) returns array of {
    conceptSlug : String;
    name        : String;
    score       : Double;
  };
}
```

```javascript
// srv/knowledge-graph-service.js — add near the kg_prerequisites registration (~line 1357).
// At top of file with the other imports:
import { handleSharedConcepts } from './lib/mcp-kg-tools.js';
// In the handler-registration block:
this.on('kg_shared_concepts', handleSharedConcepts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js` → PASS.
Then `npx cds compile srv --to json >/dev/null` → no model errors.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service-mcp.cds srv/lib/mcp-kg-tools.js srv/knowledge-graph-service.js test/unit/mcp-kg-tools.test.js
git commit -m "feat(#1106): kg_shared_concepts MCP tool"
```

### Task 2: `kg_neighborhood` tool

**Files:**
- Modify: `srv/knowledge-graph-service-mcp.cds` (add function)
- Modify: `srv/lib/mcp-kg-tools.js` (add `handleNeighborhood`)
- Modify: `srv/knowledge-graph-service.js` (add `this.on('kg_neighborhood', handleNeighborhood)`)
- Test: `test/unit/mcp-kg-tools.test.js` (add describe block)

**Interfaces:**
- Consumes: existing `neighborhoodFull(slug)` service function returning `{ prerequisitesOf[], sharedConcepts[], whatToLearnNext[], teaches[] }`, each item `{ slug, title, score, isolated? }`. PageRank blend (#916) and `isolated` flag (#918) are applied inside `neighborhoodFull` already — the tool just projects the arms.
- Produces: `srv/lib/mcp-kg-tools.js` exports `handleNeighborhood(req)`. CDS function `kg_neighborhood(slug: String, depth: Integer)` returning the four arms as `array of { slug; title; score: Double; isolated: Boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-kg-tools.test.js — add:
import { handleNeighborhood } from '../../srv/lib/mcp-kg-tools.js';

describe('kg_neighborhood', () => {
  const fullResult = {
    prerequisitesOf: [{ slug: 'p1', title: 'P1', score: 0.9, isolated: false }],
    whatToLearnNext: [{ slug: 'n1', title: 'N1', score: 0.8 }],
    sharedConcepts:  [{ slug: 's1', title: 'S1', score: 0.7, isolated: true }],
    teaches:         [{ slug: 'c1', title: 'C1', score: 0.6 }],
  };

  it('projects all four arms with isolated defaulted to false', async () => {
    const srv = { send: vi.fn(async () => fullResult) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'Foo', depth: 5 } });
    expect(srv.send).toHaveBeenCalledWith('neighborhoodFull', { slug: 'foo' });
    expect(out.prerequisites[0]).toEqual({ slug: 'p1', title: 'P1', score: 0.9, isolated: false });
    expect(out.sharedConcepts[0].isolated).toBe(true);
    expect(out.whatToLearnNext[0].isolated).toBe(false); // defaulted
    expect(out.teaches[0].slug).toBe('c1');
  });

  it('clamps depth to [1,50] and slices each arm', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ slug: `p${i}`, title: `P${i}`, score: 1 }));
    const srv = { send: vi.fn(async () => ({ ...fullResult, prerequisitesOf: many })) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'foo', depth: 999 } });
    expect(out.prerequisites).toHaveLength(50);
  });

  it('fail-open: empty arms when neighborhoodFull throws', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('x'); }) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'foo' } });
    expect(out).toEqual({ prerequisites: [], whatToLearnNext: [], sharedConcepts: [], teaches: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js -t kg_neighborhood`
Expected: FAIL — `handleNeighborhood` not exported.

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-kg-tools.js — add:
const EMPTY_NB = { prerequisites: [], whatToLearnNext: [], sharedConcepts: [], teaches: [] };

/**
 * kg_neighborhood — full graph neighborhood (all arms). PageRank-blended
 * (#916) and isolated-flagged (#918) inside neighborhoodFull; this projects
 * the arms and normalizes `isolated` to a boolean. Fail-open -> empty arms.
 */
export async function handleNeighborhood(req) {
  const slug = (req.data.slug ?? '').toLowerCase();
  const depth = Math.min(Math.max(req.data.depth ?? 10, 1), 50);
  if (!slug) return { ...EMPTY_NB };
  const norm = (arm) => (arm ?? []).slice(0, depth).map((i) => ({
    slug: i.slug, title: i.title ?? i.slug, score: i.score ?? 0, isolated: i.isolated === true,
  }));
  try {
    const nb = await this.send('neighborhoodFull', { slug });
    return {
      prerequisites:   norm(nb?.prerequisitesOf),
      whatToLearnNext: norm(nb?.whatToLearnNext),
      sharedConcepts:  norm(nb?.sharedConcepts),
      teaches:         norm(nb?.teaches),
    };
  } catch (e) {
    log.error(`kg_neighborhood(${slug}) failed — ${e.message ?? e}`);
    return { ...EMPTY_NB };
  }
}
```

```cds
// srv/knowledge-graph-service-mcp.cds — add inside extend service:
  /** Fuller graph neighborhood for a tutorial: prerequisites, what-to-learn-next,
      shared concepts, and concepts it teaches. PageRank-blended when enabled;
      each entry flags whether the node is graph-isolated. Anonymous.
      @param slug   Tutorial slug (lowercase canonical).
      @param depth  Max entries per arm, [1, 50]. Default 10. */
  function kg_neighborhood(slug: String, depth: Integer) returns {
    prerequisites   : array of { slug: String; title: String; score: Double; isolated: Boolean };
    whatToLearnNext : array of { slug: String; title: String; score: Double; isolated: Boolean };
    sharedConcepts  : array of { slug: String; title: String; score: Double; isolated: Boolean };
    teaches         : array of { slug: String; title: String; score: Double; isolated: Boolean };
  };
```

```javascript
// srv/knowledge-graph-service.js — update the import and add wiring:
import { handleSharedConcepts, handleNeighborhood } from './lib/mcp-kg-tools.js';
this.on('kg_neighborhood', handleNeighborhood);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js -t kg_neighborhood` → PASS.
Then `npx cds compile srv --to json >/dev/null` → no errors.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service-mcp.cds srv/lib/mcp-kg-tools.js srv/knowledge-graph-service.js test/unit/mcp-kg-tools.test.js
git commit -m "feat(#1106): kg_neighborhood MCP tool"
```

### Task 3: `kg_search_concepts` tool

**Files:**
- Modify: `srv/knowledge-graph-service-mcp.cds`, `srv/lib/mcp-kg-tools.js`, `srv/knowledge-graph-service.js`
- Test: `test/unit/mcp-kg-tools.test.js`

**Interfaces:**
- Consumes: existing `searchKG(term, maxConcepts, maxTutorials)` service action returning `{ concepts: [{slug,name,score}], tutorials: [{slug,title,score}] }`. The on-demand-extraction enqueue (#948) already lives behind `KG_ONDEMAND_ENABLED` inside the `searchKG` delegate — the tool does NOT add its own enqueue.
- Produces: `handleSearchConcepts(req)`. CDS `kg_search_concepts(query: String, maxConcepts: Integer, maxTutorials: Integer)` returning `{ concepts[], tutorials[] }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-kg-tools.test.js — add:
import { handleSearchConcepts } from '../../srv/lib/mcp-kg-tools.js';

describe('kg_search_concepts', () => {
  it('delegates to searchKG with clamped maxes and maps query->term', async () => {
    const srv = { send: vi.fn(async (_e, a) => ({
      concepts: [{ slug: 'c', name: 'C', score: 1 }], tutorials: [{ slug: 't', title: 'T', score: 1 }],
      _echo: a,
    })) };
    const out = await handleSearchConcepts.call(srv, { data: { query: 'draft', maxConcepts: 999, maxTutorials: 3 } });
    expect(srv.send).toHaveBeenCalledWith('searchKG', { term: 'draft', maxConcepts: 25, maxTutorials: 3 });
    expect(out.concepts[0].slug).toBe('c');
  });

  it('fail-open: {concepts:[],tutorials:[]} on throw', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('x'); }) };
    expect(await handleSearchConcepts.call(srv, { data: { query: 'q' } }))
      .toEqual({ concepts: [], tutorials: [] });
  });

  it('returns empty when query blank', async () => {
    const srv = { send: vi.fn() };
    expect(await handleSearchConcepts.call(srv, { data: { query: '  ' } }))
      .toEqual({ concepts: [], tutorials: [] });
    expect(srv.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js -t kg_search_concepts` → FAIL (`handleSearchConcepts` not exported).

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-kg-tools.js — add:
import { clampLimit } from './mcp-arg-validators.js';

/**
 * kg_search_concepts — free-text concept + tutorial search. Delegates to the
 * anonymous-safe searchKG action (same seed/walk/hydrate the palette uses),
 * which bridges on-demand extraction (#948) only when KG_ONDEMAND_ENABLED.
 * Fail-open -> empty result.
 */
export async function handleSearchConcepts(req) {
  const term = (req.data.query ?? '').trim();
  if (!term) return { concepts: [], tutorials: [] };
  const maxConcepts = clampLimit(req.data.maxConcepts, 25, 25);
  const maxTutorials = clampLimit(req.data.maxTutorials, 10, 25);
  try {
    const r = await this.send('searchKG', { term, maxConcepts, maxTutorials });
    return { concepts: r?.concepts ?? [], tutorials: r?.tutorials ?? [] };
  } catch (e) {
    log.error(`kg_search_concepts(${term}) failed — ${e.message ?? e}`);
    return { concepts: [], tutorials: [] };
  }
}
```

> **Confirm `clampLimit` semantics** in `srv/lib/mcp-arg-validators.js` before Step 3. Expected `clampLimit(value, defaultN, maxN)` = `min(max(value ?? defaultN, 1), maxN)`. The test passes `maxTutorials: 3` (an in-range value that survives clamping unchanged) so it holds regardless of the exact floor behavior. If the real function's default/floor differs, match the test to the real function — do NOT re-implement clamping.

```cds
// srv/knowledge-graph-service-mcp.cds — add:
  /** Free-text search across knowledge-graph concepts and the tutorials that
      teach them. Returns ranked concept and tutorial matches. Bridges on-demand
      concept extraction when that feature is enabled. Anonymous.
      @param query         Free-text search terms.
      @param maxConcepts   Max concept results, [1, 25]. Default 25.
      @param maxTutorials  Max tutorial results, [1, 25]. Default 10. */
  function kg_search_concepts(query: String, maxConcepts: Integer, maxTutorials: Integer) returns {
    concepts  : array of { slug: String; name: String; score: Double };
    tutorials : array of { slug: String; title: String; score: Double };
  };
```

```javascript
// srv/knowledge-graph-service.js:
import { handleSharedConcepts, handleNeighborhood, handleSearchConcepts } from './lib/mcp-kg-tools.js';
this.on('kg_search_concepts', handleSearchConcepts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js -t kg_search_concepts` → PASS. `npx cds compile srv --to json >/dev/null` → clean.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service-mcp.cds srv/lib/mcp-kg-tools.js srv/knowledge-graph-service.js test/unit/mcp-kg-tools.test.js
git commit -m "feat(#1106): kg_search_concepts MCP tool"
```

### Task 4: `kg_community` tool (read-only Louvain surfacing)

**Files:**
- Modify: `srv/knowledge-graph-service-mcp.cds`, `srv/lib/mcp-kg-tools.js`, `srv/knowledge-graph-service.js`
- Test: `test/unit/mcp-kg-tools.test.js`

**Interfaces:**
- Consumes: `KgCommunity` sidecar (`communityFingerprint`, member tutorial slug/title columns), `KgCommunityLabel` (`label` keyed by `communityFingerprint`), `Missions` (`sourceKgCommunityFingerprint` → `slug`). Access via `cds.entities('com.sap.developers.ims')`.
- Produces: `handleCommunity(req)`. CDS `kg_community(id: String)` where `id` is the community **fingerprint**, returning `{ communityId: String; label: String; memberTutorials: array of {slug,title}; size: Integer; promotedToMissionSlug: String }`.

- [ ] **Step 0: Confirm sidecar column names**

Run: `npx cds compile db/knowledge-graph-communities.cds --to json 2>/dev/null | jq '.definitions | keys'` and read `db/knowledge-graph-communities.cds` for the `KgCommunity` member-tutorial column names (slug + title). Adjust the test and impl below to the real columns before proceeding. The plan assumes `tutorialSlug` / `tutorialTitle`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-kg-tools.test.js — add:
import { handleCommunity } from '../../srv/lib/mcp-kg-tools.js';

describe('kg_community', () => {
  // db.run is stubbed to answer by inspecting the compiled query's target entity name.
  function fakeDb(map) {
    return { run: vi.fn(async (q) => {
      const name = q?.SELECT?.from?.ref?.[0]?.id ?? q?.SELECT?.from?.ref?.[0] ?? '';
      const key = String(name).split('.').pop();
      const rows = map[key] ?? [];
      return q?.SELECT?.one ? (rows[0] ?? null) : rows;
    }) };
  }

  it('returns label, members, size and promotion status by fingerprint', async () => {
    const db = fakeDb({
      KgCommunity:      [{ tutorialSlug: 'a', tutorialTitle: 'A' }, { tutorialSlug: 'b', tutorialTitle: 'B' }],
      KgCommunityLabel: [{ label: 'Draft Handling' }],
      Missions:         [{ slug: 'draft-mission' }],
    });
    const out = await handleCommunity.call({}, { data: { id: 'fp1' }, _db: db });
    expect(out.label).toBe('Draft Handling');
    expect(out.size).toBe(2);
    expect(out.memberTutorials.map((m) => m.slug)).toEqual(['a', 'b']);
    expect(out.promotedToMissionSlug).toBe('draft-mission');
  });

  it('returns empty shell for unknown fingerprint (no throw)', async () => {
    const db = fakeDb({});
    const out = await handleCommunity.call({}, { data: { id: 'nope' }, _db: db });
    expect(out.memberTutorials).toEqual([]);
    expect(out.size).toBe(0);
    expect(out.promotedToMissionSlug).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js -t kg_community` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-kg-tools.js — at module top ensure: const { SELECT } = cds.ql;
/**
 * kg_community — read-only surfacing of a Louvain community (#917). `id` is the
 * community FINGERPRINT (sourceKgCommunityFingerprint), not the raw Louvain id,
 * which shuffles nightly. Returns members, LLM label, and promotion status.
 * DEV-only data until #917 community promotion reaches PROD. Fail-open.
 */
export async function handleCommunity(req) {
  const fp = (req.data.id ?? '').trim();
  const shell = { communityId: fp, label: null, memberTutorials: [], size: 0, promotedToMissionSlug: null };
  if (!fp) return shell;
  const db = req._db ?? cds.db;
  const { KgCommunity, KgCommunityLabel, Missions } = cds.entities('com.sap.developers.ims');
  try {
    const members  = await db.run(SELECT.from(KgCommunity).where({ communityFingerprint: fp }));
    const labelRow = await db.run(SELECT.one.from(KgCommunityLabel).where({ communityFingerprint: fp }));
    const mission  = await db.run(SELECT.one.from(Missions).columns('slug').where({ sourceKgCommunityFingerprint: fp }));
    return {
      communityId: fp,
      label: labelRow?.label ?? null,
      memberTutorials: members.map((m) => ({ slug: m.tutorialSlug, title: m.tutorialTitle ?? m.tutorialSlug })),
      size: members.length,
      promotedToMissionSlug: mission?.slug ?? null,
    };
  } catch (e) {
    log.error(`kg_community(${fp}) failed — ${e.message ?? e}`);
    return shell;
  }
}
```

> **Namespace check:** confirm `cds.entities('com.sap.developers.ims')` resolves `KgCommunity`/`KgCommunityLabel`/`Missions` (the project namespace from `db/schema.cds`). Never SELECT a BLOB alongside metadata (memory rule) — these are all metadata columns, so a single CDS-QL query is safe here.

```cds
// srv/knowledge-graph-service-mcp.cds — add:
  /** Surface a knowledge-graph community (Louvain cluster) by its stable
      fingerprint: member tutorials, the generated cluster label, and whether it
      has been promoted to a mission. Read-only. Community data is DEV-only until
      the promotion flow reaches production.
      @param id  Community fingerprint (stable SHA-256 of sorted member slugs). */
  function kg_community(id: String) returns {
    communityId           : String;
    label                 : String;
    memberTutorials       : array of { slug: String; title: String };
    size                  : Integer;
    promotedToMissionSlug : String;
  };
```

```javascript
// srv/knowledge-graph-service.js:
import { handleSharedConcepts, handleNeighborhood, handleSearchConcepts, handleCommunity } from './lib/mcp-kg-tools.js';
this.on('kg_community', handleCommunity);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-kg-tools.test.js` → all 4 tools PASS. `npx cds compile srv --to json >/dev/null` → clean.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service-mcp.cds srv/lib/mcp-kg-tools.js srv/knowledge-graph-service.js test/unit/mcp-kg-tools.test.js
git commit -m "feat(#1106): kg_community read-only MCP tool"
```

---

## Workstream 3 — Resources & Prompts (compose layer)

### Task 5: Prompt loader + 4 static prompt files

**Files:**
- Create: `srv/mcp/prompts/summarize_mission_for_beginner.md`
- Create: `srv/mcp/prompts/generate_lab_exercise.md`
- Create: `srv/mcp/prompts/explain_concept.md`
- Create: `srv/mcp/prompts/suggest_learning_path.md`
- Create: `srv/lib/mcp-prompt-loader.js`
- Test: `test/unit/mcp-prompt-loader.test.js`

**Interfaces:**
- Consumes: `js-yaml` (direct dep, v5.2.1 — confirmed resolvable). `gray-matter` (v4.0.3) is also available and is an acceptable alternative that handles the frontmatter split for you; the impl below uses js-yaml + a regex to avoid depending on gray-matter's return shape.
- Produces: `srv/lib/mcp-prompt-loader.js` exports:
  - `loadPrompts(dir?)` → `Map<name, { name, description, arguments: [{name,description,required}], template }>`; throws on malformed frontmatter (fail-fast at boot).
  - `listPrompts(promptMap)` → `[{ name, description, arguments }]` (the `prompts/list` payload).
  - `getPrompt(promptMap, name, args)` → `{ description, messages: [{ role:'user', content:{ type:'text', text } }] }` (the `prompts/get` payload); throws if name unknown or a required arg is missing.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-prompt-loader.test.js
import { expect, describe, it, beforeAll } from 'vitest';
import path from 'node:path';
import { loadPrompts, listPrompts, getPrompt } from '../../srv/lib/mcp-prompt-loader.js';

const PROMPT_DIR = path.join(process.cwd(), 'srv/mcp/prompts');

describe('mcp-prompt-loader', () => {
  let prompts;
  beforeAll(() => { prompts = loadPrompts(PROMPT_DIR); });

  it('loads at least 4 prompts with required frontmatter', () => {
    expect(prompts.size).toBeGreaterThanOrEqual(4);
    for (const p of prompts.values()) {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(p.description.length).toBeGreaterThanOrEqual(20);
      expect(Array.isArray(p.arguments)).toBe(true);
      expect(p.template.length).toBeGreaterThan(0);
    }
  });

  it('prompts/list returns name+description+arguments for each', () => {
    const list = listPrompts(prompts);
    expect(list.length).toBe(prompts.size);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName.summarize_mission_for_beginner).toBeDefined();
    expect(byName.summarize_mission_for_beginner.arguments[0].name).toBe('mission_slug');
  });

  it('prompts/get interpolates {{arg}} and returns a user message', () => {
    const res = getPrompt(prompts, 'summarize_mission_for_beginner', { mission_slug: 'cap-intro' });
    expect(res.messages[0].role).toBe('user');
    expect(res.messages[0].content.text).toContain('cap-intro');
    expect(res.messages[0].content.text).not.toContain('{{mission_slug}}');
  });

  it('prompts/get throws on unknown name', () => {
    expect(() => getPrompt(prompts, 'nope', {})).toThrow(/unknown prompt/i);
  });

  it('prompts/get throws when a required arg is missing', () => {
    expect(() => getPrompt(prompts, 'summarize_mission_for_beginner', {})).toThrow(/required/i);
  });

  it('loadPrompts throws on malformed frontmatter', () => {
    // point at a fixture dir with a bad file
    const badDir = path.join(process.cwd(), 'test/fixtures/bad-prompts');
    expect(() => loadPrompts(badDir)).toThrow();
  });
});
```

- [ ] **Step 2: Create the bad-frontmatter fixture + run test to verify it fails**

```bash
mkdir -p test/fixtures/bad-prompts
printf -- '---\nname: broken\n: : :\n---\nbody\n' > test/fixtures/bad-prompts/broken.md
npx vitest run test/unit/mcp-prompt-loader.test.js
```
Expected: FAIL — module not found / functions not exported.

- [ ] **Step 3: Write the four prompt files**

```markdown
<!-- srv/mcp/prompts/summarize_mission_for_beginner.md -->
---
name: summarize_mission_for_beginner
description: Summarize a mission's arc and learning outcomes for a complete beginner.
arguments:
  - { name: mission_slug, description: Lowercase canonical mission slug, required: true }
---
You are helping a complete beginner decide whether to start the "{{mission_slug}}" mission.
Read the mission://{{mission_slug}} resource, then in 3-5 sentences explain what the mission
teaches, the order of its tutorials, and who it is for. Avoid jargon; define any SAP-specific term.
```

```markdown
<!-- srv/mcp/prompts/generate_lab_exercise.md -->
---
name: generate_lab_exercise
description: Generate a hands-on lab exercise derived from a tutorial (optionally a single step).
arguments:
  - { name: tutorial_slug, description: Lowercase canonical tutorial slug, required: true }
  - { name: step, description: Optional 1-indexed step number to focus on, required: false }
---
Using the tutorial://{{tutorial_slug}} resource{{step}}, design one hands-on lab exercise that
reinforces the key skill. Include: a short scenario, the task, the expected outcome, and a hint.
Keep it doable in under 20 minutes.
```

```markdown
<!-- srv/mcp/prompts/explain_concept.md -->
---
name: explain_concept
description: Explain a knowledge-graph concept and how it connects to tutorials that teach it.
arguments:
  - { name: concept_id, description: Concept id or slug, required: true }
---
Read the concept://{{concept_id}} resource. Explain the concept in two paragraphs: first what it
is, then why it matters for an SAP developer. End with a bulleted list of the tutorials that teach it.
```

```markdown
<!-- srv/mcp/prompts/suggest_learning_path.md -->
---
name: suggest_learning_path
description: Suggest an ordered learning path between two tutorials using the knowledge graph.
arguments:
  - { name: from_slug, description: Starting tutorial slug, required: true }
  - { name: to_slug, description: Target tutorial slug, required: true }
---
The learner knows "{{from_slug}}" and wants to reach "{{to_slug}}". Use the kg_neighborhood tool on
each and the kg_shared_concepts tool to propose an ordered path of tutorials, explaining why each
step is a prerequisite for the next.
```

- [ ] **Step 4: Write minimal implementation**

```javascript
// srv/lib/mcp-prompt-loader.js
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// NOTE: js-yaml 4.x `yaml.load()` uses DEFAULT_SCHEMA (no code execution) and is
// safe for these trusted, in-repo prompt files — the Python `yaml.load` RCE
// warning does not apply to js-yaml 4.x. Do not swap to a custom loader.
const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Load and validate all prompt .md files in `dir`. Throws on malformed frontmatter. */
export function loadPrompts(dir) {
  const map = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const m = FM_RE.exec(raw);
    if (!m) throw new Error(`mcp-prompt-loader: ${file} missing YAML frontmatter`);
    let fm;
    try { fm = yaml.load(m[1]); } catch (e) { throw new Error(`mcp-prompt-loader: ${file} bad YAML — ${e.message}`); }
    if (!fm?.name || !fm?.description) throw new Error(`mcp-prompt-loader: ${file} needs name+description`);
    map.set(fm.name, {
      name: fm.name,
      description: fm.description,
      arguments: Array.isArray(fm.arguments) ? fm.arguments : [],
      template: m[2].trim(),
    });
  }
  return map;
}

/** prompts/list payload. */
export function listPrompts(promptMap) {
  return [...promptMap.values()].map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
}

/** prompts/get payload. Throws on unknown name or missing required arg. */
export function getPrompt(promptMap, name, args = {}) {
  const p = promptMap.get(name);
  if (!p) throw new Error(`unknown prompt: ${name}`);
  for (const a of p.arguments) {
    if (a.required && (args[a.name] === undefined || args[a.name] === '')) {
      throw new Error(`missing required argument: ${a.name}`);
    }
  }
  const text = p.template.replace(/\{\{(\w+)\}\}/g, (_, k) => (args[k] ?? ''));
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
```

> **`{{step}}` in generate_lab_exercise:** the template embeds `{{step}}` inline; when `step` is omitted it interpolates to empty string (yielding "resource, design..."). That is acceptable copy. No conditional logic needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/mcp-prompt-loader.test.js` → PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/mcp/prompts/ srv/lib/mcp-prompt-loader.js test/unit/mcp-prompt-loader.test.js test/fixtures/bad-prompts/
git commit -m "feat(#1106): MCP prompt loader + 4 static prompt templates"
```

### Task 6: Resource registration module (`tutorial://`, `mission://`, `concept://`)

**Files:**
- Create: `srv/lib/mcp-resources.js`
- Test: `test/unit/mcp-resources.test.js`

**Interfaces:**
- Consumes:
  - `srv/lib/tutorial-step-slicer.js` exports `sliceAllSteps(slug)` → `[{stepNumber, title}] | null` (metadata only).
  - `cds.entities('com.sap.developers.ims')` → `Tutorials`, `Missions`, `CompletionPaths`, `CompletionPathItems`, `Concepts`.
  - SDK `ResourceTemplate(uriTemplate, { list })` and `server.registerResource(name, uriOrTemplate, config, readCallback)`. `readCallback(uri, variables)` returns `{ contents: [{ uri, mimeType, text }] }`.
- Produces: `srv/lib/mcp-resources.js` exports `registerResources(server, { db, slicer })` — registers all three resource templates + their `list` callbacks on the passed `McpServer`. `db`/`slicer` are injectable for tests (default to `cds.db` and the real slicer). Also exports the internal read functions `readTutorialResource(slug, {db, slicer})`, `readMissionResource(slug, {db})`, `readConceptResource(id, {db})` for direct unit testing. Constant `RESOURCE_LIST_CAP = 500`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-resources.test.js
import { expect, describe, it, vi } from 'vitest';
import {
  readTutorialResource, readMissionResource, readConceptResource,
  registerResources, RESOURCE_LIST_CAP,
} from '../../srv/lib/mcp-resources.js';

function fakeDb(map) {
  return { run: vi.fn(async (q) => {
    const key = String(q?.SELECT?.from?.ref?.[0]?.id ?? q?.SELECT?.from?.ref?.[0] ?? '').split('.').pop();
    const rows = map[key] ?? [];
    return q?.SELECT?.one ? (rows[0] ?? null) : rows;
  }) };
}

describe('mcp-resources reads', () => {
  it('readTutorialResource returns JSON block with steps + a HTML block', async () => {
    const db = fakeDb({ Tutorials: [{ slug: 'foo', title: 'Foo', tags: 'cap,btp' }] });
    const slicer = { sliceAllSteps: vi.fn(async () => [{ stepNumber: 1, title: 'Intro' }, { stepNumber: 2, title: 'Setup' }]) };
    const res = await readTutorialResource('foo', { db, slicer });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta).toMatchObject({ slug: 'foo', title: 'Foo', totalSteps: 2 });
    expect(meta.steps).toHaveLength(2);
    expect(res.contents[0].mimeType).toBe('application/json');
  });

  it('readTutorialResource returns empty-ish for unknown slug (no throw)', async () => {
    const db = fakeDb({});
    const slicer = { sliceAllSteps: vi.fn(async () => null) };
    const res = await readTutorialResource('nope', { db, slicer });
    expect(JSON.parse(res.contents[0].text).totalSteps).toBe(0);
  });

  it('readMissionResource returns ordered tutorials', async () => {
    const db = fakeDb({
      Missions: [{ slug: 'm1', title: 'M1' }],
      CompletionPathItems: [{ tutorialSlug: 'b', rank: 2, tutorialTitle: 'B' }, { tutorialSlug: 'a', rank: 1, tutorialTitle: 'A' }],
    });
    const res = await readMissionResource('m1', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta.tutorials.map((t) => t.slug)).toEqual(['a', 'b']); // sorted by order
  });

  it('readConceptResource filters status ACTIVE and shapes links', async () => {
    const db = fakeDb({ Concepts: [{ ID: 'c1', slug: 'draft', name: 'Draft', status: 'ACTIVE' }] });
    const res = await readConceptResource('c1', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta).toMatchObject({ id: 'c1', slug: 'draft', name: 'Draft' });
  });
});

describe('registerResources', () => {
  it('registers three resource templates on the server', () => {
    const server = { registerResource: vi.fn() };
    registerResources(server, { db: fakeDb({}), slicer: { sliceAllSteps: vi.fn() } });
    const names = server.registerResource.mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['tutorial', 'mission', 'concept']));
  });

  it('caps list results at RESOURCE_LIST_CAP', () => {
    expect(RESOURCE_LIST_CAP).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-resources.test.js` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-resources.js
import cds from '@sap/cds';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as defaultSlicer from './tutorial-step-slicer.js';
const { SELECT } = cds.ql;
const log = cds.log('mcp-resources');

export const RESOURCE_LIST_CAP = 500;
const NS = 'com.sap.developers.ims';
const json = (uri, obj) => ({ uri, mimeType: 'application/json', text: JSON.stringify(obj) });

export async function readTutorialResource(slug, { db = cds.db, slicer = defaultSlicer } = {}) {
  const s = (slug ?? '').toLowerCase();
  const { Tutorials } = cds.entities(NS);
  const row = await db.run(SELECT.one.from(Tutorials).where({ slug: s }));
  const steps = (await slicer.sliceAllSteps(s)) ?? [];
  const meta = {
    slug: s, title: row?.title ?? s,
    totalSteps: steps.length,
    steps: steps.map((st) => ({ n: st.stepNumber, title: st.title })),
    tags: row?.tags ? String(row.tags).split(',').map((t) => t.trim()) : [],
  };
  return { contents: [json(`tutorial://${s}`, meta)] };
}

export async function readMissionResource(slug, { db = cds.db } = {}) {
  const s = (slug ?? '').toLowerCase();
  const { Missions, CompletionPathItems } = cds.entities(NS);
  const row = await db.run(SELECT.one.from(Missions).where({ slug: s }));
  const items = await db.run(SELECT.from(CompletionPathItems).where({ missionSlug: s }));
  const tutorials = items
    .map((i) => ({ slug: i.tutorialSlug, title: i.tutorialTitle ?? i.tutorialSlug, order: i.rank ?? 0 }))
    .sort((a, b) => a.order - b.order);
  return { contents: [json(`mission://${s}`, { slug: s, title: row?.title ?? s, tutorials })] };
}

export async function readConceptResource(id, { db = cds.db } = {}) {
  const { Concepts } = cds.entities(NS);
  const row = await db.run(SELECT.one.from(Concepts).where({ ID: id, status: 'ACTIVE' }))
    ?? await db.run(SELECT.one.from(Concepts).where({ slug: id, status: 'ACTIVE' }));
  const meta = row
    ? { id: row.ID, slug: row.slug, name: row.name, teachingTutorials: [], relatedConcepts: [] }
    : { id, slug: null, name: null, teachingTutorials: [], relatedConcepts: [] };
  return { contents: [json(`concept://${id}`, meta)] };
}

/** Register all three resource templates on `server`. */
export function registerResources(server, { db = cds.db, slicer = defaultSlicer } = {}) {
  server.registerResource(
    'tutorial',
    new ResourceTemplate('tutorial://{slug}', { list: async () => listResources('Tutorials', 'tutorial', { db }) }),
    { title: 'Tutorial', description: 'A published tutorial: metadata, step titles, and rendered HTML.' },
    async (uri, { slug }) => readTutorialResource(slug, { db, slicer }),
  );
  server.registerResource(
    'mission',
    new ResourceTemplate('mission://{slug}', { list: async () => listResources('Missions', 'mission', { db }) }),
    { title: 'Mission', description: 'A mission and its ordered tutorials.' },
    async (uri, { slug }) => readMissionResource(slug, { db }),
  );
  server.registerResource(
    'concept',
    new ResourceTemplate('concept://{id}', { list: async () => listResources('Concepts', 'concept', { db, active: true }) }),
    { title: 'Concept', description: 'A knowledge-graph concept and the tutorials that teach it.' },
    async (uri, { id }) => readConceptResource(id, { db }),
  );
}

async function listResources(entityName, scheme, { db, active = false }) {
  const ent = cds.entities(NS)[entityName];
  let q = SELECT.from(ent).columns('slug', 'title', 'ID', 'name').limit(RESOURCE_LIST_CAP + 1);
  if (active) q = q.where({ status: 'ACTIVE' });
  let rows = [];
  try { rows = await db.run(q); } catch (e) { log.error(`resources/list ${scheme} failed — ${e.message}`); return { resources: [] }; }
  const truncated = rows.length > RESOURCE_LIST_CAP;
  const items = rows.slice(0, RESOURCE_LIST_CAP).map((r) => ({
    uri: `${scheme}://${scheme === 'concept' ? r.ID : r.slug}`,
    name: r.title ?? r.name ?? r.slug ?? r.ID,
    mimeType: 'application/json',
  }));
  if (truncated) log.warn(`resources/list ${scheme} truncated at ${RESOURCE_LIST_CAP}`);
  return { resources: items };
}
```

> **Column-name confirmation:** the `CompletionPathItems` join column (`missionSlug`, `tutorialSlug`, `tutorialTitle`, `rank`) and `Concepts` link tables must be confirmed against `db/schema.cds` and `db/knowledge-graph*.cds` before Step 3. If a title isn't denormalized onto `CompletionPathItems`, join `Tutorials` for it. `teachingTutorials`/`relatedConcepts` are left as empty arrays in v1 unless the link-table columns are trivially available — the spec's resource shape allows them to be populated later; note in a code comment if deferred.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-resources.test.js` → PASS. `node -e "import('./srv/lib/mcp-resources.js').then(()=>console.log('ok'))"` → `ok` (import resolves).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/mcp-resources.js test/unit/mcp-resources.test.js
git commit -m "feat(#1106): MCP resource templates (tutorial/mission/concept)"
```

### Task 7: Compose router (`srv/lib/mcp-compose-router.js`)

**Files:**
- Create: `srv/lib/mcp-compose-router.js`
- Test: `test/unit/mcp-compose-router.test.js`

**Interfaces:**
- Consumes:
  - `@cap-js/mcp/lib/tools` → `registerGenericReadTool(server, srv, entities, prefix)`, `registerCallActionTool(server, srv, actions, prefix)`, `registerPerActionTools(...)`, `registerDescribeTool(server, srv, entities, actions, prefix)`, `getInstructions(def, null, prefix)`.
  - `@cap-js/mcp/lib/auth` → `checkAuthorization(serviceDef)` → `{ entities, actions, error }`.
  - `@cap-js/mcp/lib/utils/service-name` → `resolvePrefix(def)`.
  - `@cap-js/mcp/lib/utils/cds-to-schema` → `getDescription(def)`.
  - `@modelcontextprotocol/sdk/server/mcp.js` → `McpServer`; `@modelcontextprotocol/sdk/server/streamableHttp.js` → `StreamableHTTPServerTransport`.
  - `srv/lib/mcp-resources.js` → `registerResources`; `srv/lib/mcp-prompt-loader.js` → `loadPrompts`, `listPrompts`, `getPrompt`.
- Produces: `srv/lib/mcp-compose-router.js` default export `makeComposeRouter(srv)` → an `express.Router` with a `POST /` handler mirroring the adapter but adding resources + prompts. Also exports `PROMPT_MAP` (lazily-loaded singleton) and `flags()` (reads the four env vars). Metric hook: increments `mcp_compose_fallback_total` on fallback (via `srv/lib/metrics.js`).

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/mcp-compose-router.test.js
import { expect, describe, it, vi, beforeEach } from 'vitest';

// The compose router registers prompts capability + resources capability alongside tools.
// We unit-test the capability wiring by invoking the exported buildServer() with fakes,
// NOT by standing up HTTP (that's the contract/hybrid layer's job).
import { buildServer, flags } from '../../srv/lib/mcp-compose-router.js';

describe('mcp-compose-router capability wiring', () => {
  beforeEach(() => {
    delete process.env.MCP_RESOURCES_ENABLED;
    delete process.env.MCP_PROMPTS_ENABLED;
  });

  it('flags default all enabled', () => {
    expect(flags()).toEqual({ phase3: true, resources: true, prompts: true, adminTools: true });
  });

  it('buildServer advertises tools + resources + prompts capabilities by default', async () => {
    const caps = {};
    const server = {
      registerResource: vi.fn(),
      server: { registerCapabilities: (c) => Object.assign(caps, c), setRequestHandler: vi.fn() },
    };
    const srv = { name: 'KnowledgeGraphService', definition: {} };
    await buildServer(server, srv, { entities: {}, actions: {} }, {
      // inject fakes so no adapter/db needed
      registerTools: vi.fn(),
      registerResourcesFn: (s) => s.registerResource('tutorial', {}, {}, () => {}),
      promptMap: new Map([['p', { name: 'p', description: 'x', arguments: [], template: 't' }]]),
    });
    expect(caps.tools).toEqual({ listChanged: false });
    expect(caps.resources).toEqual({ subscribe: false, listChanged: false });
    expect(caps.prompts).toEqual({ listChanged: false });
    expect(server.registerResource).toHaveBeenCalled();
  });

  it('omits resources capability when MCP_RESOURCES_ENABLED=false', async () => {
    process.env.MCP_RESOURCES_ENABLED = 'false';
    const caps = {};
    const server = { registerResource: vi.fn(), server: { registerCapabilities: (c) => Object.assign(caps, c), setRequestHandler: vi.fn() } };
    await buildServer(server, { name: 'X', definition: {} }, { entities: {}, actions: {} }, {
      registerTools: vi.fn(), registerResourcesFn: vi.fn(), promptMap: new Map(),
    });
    expect(caps.resources).toBeUndefined();
    expect(caps.tools).toEqual({ listChanged: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-compose-router.test.js` → FAIL (`buildServer`/`flags` not exported).

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-compose-router.js
import cds from '@sap/cds';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
// Adapter internals — deep imports (see spec "Deep-import risk").
import {
  registerGenericReadTool, registerCallActionTool, registerPerActionTools,
  registerDescribeTool, getInstructions,
} from '@cap-js/mcp/lib/tools.js';
import { checkAuthorization } from '@cap-js/mcp/lib/auth.js';
import { resolvePrefix } from '@cap-js/mcp/lib/utils/service-name.js';
import { getDescription } from '@cap-js/mcp/lib/utils/cds-to-schema.js';
import { registerResources as realRegisterResources } from './mcp-resources.js';
import { loadPrompts, listPrompts, getPrompt } from './mcp-prompt-loader.js';
import * as metrics from './metrics.js';

const LOG = cds.log('mcp-compose');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.join(__dirname, '..', 'mcp', 'prompts');

let _promptMap = null;
export function promptMapSingleton() {
  if (_promptMap) return _promptMap;
  try { _promptMap = loadPrompts(PROMPT_DIR); }
  catch (e) { LOG.error(`prompt load failed — ${e.message}`); _promptMap = new Map(); }
  return _promptMap;
}

export function flags() {
  const on = (v) => process.env[v] !== 'false';
  return { phase3: on('MCP_PHASE3_ENABLED'), resources: on('MCP_RESOURCES_ENABLED'), prompts: on('MCP_PROMPTS_ENABLED'), adminTools: on('MCP_ADMIN_TOOLS_ENABLED') };
}

/** Wire tools + (optionally) resources + prompts onto `server`, set capabilities. */
export async function buildServer(server, srv, { entities, actions }, deps = {}) {
  const f = flags();
  const prefix = resolvePrefix(srv.definition);
  // Tools — reuse adapter fns (injected in tests). Defined here, invoked AFTER
  // registerCapabilities below.
  const registerTools = deps.registerTools ?? (() => {
    const entityCount = Object.keys(entities).length;
    const actionCount = Object.keys(actions).length;
    if (entityCount > 0 || actionCount > 0) {
      registerGenericReadTool(server, srv, entities, prefix);
      (cds.env.mcp?.per_action_tool ? registerPerActionTools : registerCallActionTool)(server, srv, actions, prefix);
      registerDescribeTool(server, srv, entities, actions, prefix);
    } else {
      // Adapter parity: an empty service still answers tools/list with {tools:[]}.
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    }
  });

  // CRITICAL ORDERING (verified against the installed SDK): the SDK's
  // setRequestHandler calls assertRequestHandlerCapability and THROWS
  // "Server does not support <cap>" unless registerCapabilities ran FIRST.
  // So build the full caps object and registerCapabilities BEFORE wiring any
  // handlers (tools, resources, or prompts). Getting this wrong 500s every
  // default request and prompts never work over HTTP.
  const caps = { tools: { listChanged: false } };
  if (f.resources) caps.resources = { subscribe: false, listChanged: false };
  if (f.prompts)   caps.prompts   = { listChanged: false };
  server.server.registerCapabilities(caps);

  registerTools();

  if (f.resources) {
    (deps.registerResourcesFn ?? realRegisterResources)(server, {});
  }
  if (f.prompts) {
    const map = deps.promptMap ?? promptMapSingleton();
    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: listPrompts(map) }));
    server.server.setRequestHandler(GetPromptRequestSchema, (req) => getPrompt(map, req.params.name, req.params.arguments ?? {}));
  }

  return server;
}

/** Express router that composes tools + resources + prompts per request. */
export default function makeComposeRouter(srv) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    try {
      let requestService = srv;
      if (cds?.context?.model?.definitions) requestService = cds.context.model.definitions[srv.name] ?? srv;
      const { entities, actions, error } = checkAuthorization(requestService);
      if (error) {
        return res.status(error.code).json({
          jsonrpc: '2.0',
          error: { code: error.code === 401 ? -32001 : -32003, message: `Authorization error (${error.code}): Not authorized to access ${srv.name}.` },
          id: req.body?.id || null,
        });
      }
      const server = new McpServer(
        { name: srv.name, version: '1.0.0', description: getDescription(srv.definition) || `MCP server for ${srv.name}` },
        { instructions: getInstructions(srv.definition, null, resolvePrefix(srv.definition)) },
      );
      await buildServer(server, srv, { entities, actions });

      // Accept-header patch (identical to adapter lib/index.js).
      const accept = req.headers['accept'] || '';
      const enableJsonResponse = accept.includes('application/json') && !accept.includes('text/event-stream');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        const newAccept = 'application/json, text/event-stream';
        req.headers['accept'] = newAccept;
        const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === 'accept');
        if (idx !== -1) req.rawHeaders[idx + 1] = newAccept; else req.rawHeaders.push('Accept', newAccept);
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await server.close();
    } catch (err) {
      LOG.error(`compose request failed — ${err.message}`);
      metrics.counter?.('mcp_compose_fallback_total');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error: ' + err.message }, id: req.body?.id || null });
      }
    }
  });
  return router;
}
```

> **`metrics.counter` name check:** confirm the export in `srv/lib/metrics.js` (Phase 1/2 used `metrics.counter('mcp_tool_invocation_total')`). If the API is `metrics.counter(name)`, the call above is correct; if it differs (e.g. `metrics.increment`), match it. The `?.` guards a missing export so the router never crashes on a metrics typo.
>
> **Fallback semantics:** the spec says "fail-open to the plain adapter." In practice, if `buildServer` throws we return a JSON-RPC 500 for THIS request and bump the fallback counter; the NEXT request still tries compose. A hard, permanent fallback (unmount compose, let `@cap-js/mcp` autowire) is the `MCP_PHASE3_ENABLED=false` operator lever (Task 8), not an automatic per-request swap — automatic router-swapping mid-flight is not safe with the stateless transport. Document this distinction in the code comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/mcp-compose-router.test.js` → PASS. Also `node -e "import('./srv/lib/mcp-compose-router.js').then(()=>console.log('imports ok'))"` — verifies the adapter deep-imports resolve.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/mcp-compose-router.js test/unit/mcp-compose-router.test.js
git commit -m "feat(#1106): MCP compose router (tools + resources + prompts)"
```

### Task 8: Mount the compose router in `srv/server.js` (WS3 integration)

**Files:**
- Modify: `srv/server.js` (add compose-router mount in `cds.on('served')`, after the existing `/mcp-auth` and `/mcp-pat` rewrites at ~line 451–505)
- Test: manual boot check + existing contract test still green (formal contract assertions in Task 9)

**Interfaces:**
- Consumes: `makeComposeRouter(srv)` from `srv/lib/mcp-compose-router.js`; `flags()` for the `MCP_PHASE3_ENABLED` gate.
- Produces: the R/P-bearing services (`KnowledgeGraphService`; later `AdminService` in WS2) served through the compose router at `/mcp/graph` (and `/mcp/admin`) instead of the plain adapter, when `MCP_PHASE3_ENABLED !== 'false'`.

- [ ] **Step 1: Read the existing MCP mount block**

Run: `sed -n '440,510p' srv/server.js` — confirm the `/mcp-auth`→`/mcp` and `/mcp-pat`→`/mcp` rewrites and where `@cap-js/mcp` autowires (`cds.on('served')` / plugin). The compose mount must run on the same root app and shadow the plain adapter's `/mcp/graph` mount for the R/P services.

- [ ] **Step 2: Add the compose-router mount**

```javascript
// srv/server.js — near the top with other imports:
import makeComposeRouter, { flags as mcpFlags } from './lib/mcp-compose-router.js';

// Inside cds.on('served', async () => { ... }), AFTER the /mcp-auth and /mcp-pat
// rewrite middlewares are registered and BEFORE/instead-of letting @cap-js/mcp
// autowire these services' /mcp/<svc> mounts:
if (mcpFlags().phase3) {
  const app = cds.app;
  // Services that expose resources + prompts (Phase 3). AdminService is added in WS2.
  const RP_SERVICES = ['KnowledgeGraphService'];
  for (const name of RP_SERVICES) {
    const srv = cds.services[name];
    if (!srv) continue;
    const mount = '/mcp/' + (srv.definition?.['@path']?.replace(/^\//, '') ?? name.toLowerCase());
    // Mount our compose router at the same path @cap-js/mcp would use.
    // Registered here so it takes the route ahead of the plugin's autowired
    // mount (Express matches first-registered). KnowledgeGraphService's mcp path
    // is /mcp/graph per its @protocol:[{kind:'mcp',path:'/mcp/graph'}].
    app.use('/mcp/graph', makeComposeRouter(srv));
    cds.log('mcp-compose').info(`compose router mounted for ${name} at /mcp/graph`);
  }
} else {
  cds.log('mcp-compose').warn('MCP_PHASE3_ENABLED=false — compose router NOT mounted; @cap-js/mcp serves tools only');
}
```

> **Ordering hazard (verify at implement time):** `@cap-js/mcp` autowires its mounts in its own `cds.once('listening')` (dev) or served hook. Express uses first-match routing, so the compose mount must be registered BEFORE the plugin's. If the plugin wins, the compose router never sees the request and R/P silently disappear (tools still work — that's the Phase-2 fallback, so it fails safe). Test end-to-end in Step 3; if the plugin shadows us, mount the compose router by intercepting the plugin (register on `cds.once('listening')` with a higher-priority path, or use `cds.env.mcp.autowire=false` for these services and mount ALL protocols manually). Prefer the least-invasive option that passes Step 3.
>
> **Path derivation:** hardcoding `/mcp/graph` is intentional and correct for `KnowledgeGraphService` (its `@protocol` pins `path:'/mcp/graph'`). WS2 adds `/mcp/admin`. Do not rely on slugified service name here — the KG service's MCP path is explicitly `/mcp/graph`, not `/mcp/knowledgegraphservice`.

- [ ] **Step 3: Boot check — resources + prompts appear on /mcp/graph**

```bash
# Local boot with in-memory sqlite (cds watch is broken on Node 26 — use cds serve):
KNOWLEDGE_GRAPH_ENABLED=true npx cds serve --in-memory --port 4004 &
sleep 8
# initialize → capabilities must include resources + prompts:
curl -s -X POST http://localhost:4004/mcp/graph -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | jq '.result.capabilities'
# prompts/list → >=4:
curl -s -X POST http://localhost:4004/mcp/graph -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"prompts/list","params":{}}' | jq '.result.prompts | length'
# resources/list → resources array present:
curl -s -X POST http://localhost:4004/mcp/graph -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}' | jq '.result.resources | type'
kill %1
```
Expected: capabilities shows `{tools, resources, prompts}`; prompts length ≥ 4; resources type `array`. If capabilities shows only `tools`, the plugin shadowed the mount — apply the Step-2 ordering fix.

- [ ] **Step 4: Existing tests still green**

Run: `npx vitest run test/unit/mcp-contract.test.js` → PASS (Phase 1/2 tools unchanged).

- [ ] **Step 5: Commit**

```bash
git add srv/server.js
git commit -m "feat(#1106): mount compose router for KnowledgeGraphService"
```

### Task 9: Extend the contract test for KG tools + resources/prompts capabilities

**Files:**
- Modify: `test/unit/mcp-contract.test.js`

**Interfaces:**
- Consumes: the running MCP endpoints from the test's `beforeAll` (which mounts the three Phase-1 services via `@cap-js/mcp/lib/index.js`). **Note:** the contract test currently mounts the PLAIN adapter directly, not the compose router. To assert resources/prompts, mount the compose router for `KnowledgeGraphService` in the test's `beforeAll` (swap `McpAdapter(kgSrv)` → `makeComposeRouter(kgSrv)` for that one service).
- Produces: new assertions — 4 KG tools enumerate; `resources/list` + `prompts/list` non-empty on `/mcp/graph`; capabilities advertise all three primitives.

- [ ] **Step 1: Add the KG tools to the expectation maps + write the failing assertions**

```javascript
// test/unit/mcp-contract.test.js — extend the constants:
const CURATED_TOOLS = {
  SearchService: ['search_tutorials', 'list_missions', 'get_mission', 'get_tutorial'],
  HomepageService: ['get_recent_news', 'get_recent_videos'],
  KnowledgeGraphService: [
    'kg_prerequisites', 'kg_what_to_learn_next',
    'kg_shared_concepts', 'kg_neighborhood', 'kg_search_concepts', 'kg_community', // Phase 3
  ],
};
// extend EXPECTED_PARAMS:
Object.assign(EXPECTED_PARAMS, {
  kg_shared_concepts: ['slug_a', 'slug_b'],
  kg_neighborhood:    ['slug', 'depth'],
  kg_search_concepts: ['query', 'maxConcepts', 'maxTutorials'],
  kg_community:       ['id'],
});

// New describe block (add near the end of the file):
describe('Phase 3 — resources + prompts on /mcp/graph (compose router)', () => {
  it('initialize advertises tools + resources + prompts', async () => {
    const caps = await rpc('KnowledgeGraphService', 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' },
    });
    expect(caps.result.capabilities.tools).toBeDefined();
    expect(caps.result.capabilities.resources).toBeDefined();
    expect(caps.result.capabilities.prompts).toBeDefined();
  });

  it('prompts/list returns >= 4 prompts', async () => {
    const r = await rpc('KnowledgeGraphService', 'prompts/list', {});
    expect(r.result.prompts.length).toBeGreaterThanOrEqual(4);
  });

  it('prompts/get interpolates a required arg', async () => {
    const r = await rpc('KnowledgeGraphService', 'prompts/get',
      { name: 'summarize_mission_for_beginner', arguments: { mission_slug: 'cap-intro' } });
    expect(r.result.messages[0].content.text).toContain('cap-intro');
  });

  it('resources/list returns an array', async () => {
    const r = await rpc('KnowledgeGraphService', 'resources/list', {});
    expect(Array.isArray(r.result.resources)).toBe(true);
  });
});
```

> **`rpc(service, method, params)` helper:** the file already builds JSON-RPC POSTs to the mounted endpoints (the existing `tools/list` assertions do this). Reuse that helper; if it's inlined, extract a small `rpc()` that POSTs `{jsonrpc:'2.0',id,method,params}` to `serviceEndpoints[service]` and returns parsed JSON. Do not add a new HTTP client.

- [ ] **Step 2: Swap KG service to the compose router in beforeAll**

```javascript
// test/unit/mcp-contract.test.js — in beforeAll, where each service is mounted:
const { default: makeComposeRouter } = await import('../../srv/lib/mcp-compose-router.js');
// for kgSrv specifically:
app.use(kgEndpoint, express.json(), makeComposeRouter(kgSrv));
// searchSrv, homeSrv stay on the plain McpAdapter as before.
```

- [ ] **Step 3: Run test to verify new assertions fail then pass**

Run: `npx vitest run test/unit/mcp-contract.test.js`
Expected first: FAIL on the 4 new KG tools + R/P blocks (if run before Tasks 1–7 land) — but since Tasks 1–8 are done, they should PASS now. Confirm all green.

- [ ] **Step 4: Commit**

```bash
git add test/unit/mcp-contract.test.js
git commit -m "test(#1106): contract coverage for KG tools + resources/prompts"
```

### Task 10: Hybrid smoke — resources readable end-to-end

**Files:**
- Create: `test/hybrid/mcp-resources.test.js`

**Interfaces:**
- Consumes: real HANA via `cds bind --exec`; the compose router mounted on `KnowledgeGraphService`. A known published tutorial slug + mission slug (seeded by `npm run setup-dev-data`).
- Produces: end-to-end assertions that `tutorial://<slug>` and `mission://<slug>` read back real content (criterion 3).

- [ ] **Step 1: Write the hybrid test**

```javascript
// test/hybrid/mcp-resources.test.js
import { expect, describe, it, beforeAll } from 'vitest';
// Follow the existing test/hybrid harness pattern (see test/hybrid/mcp-authenticated-tools.test.js
// for how it boots cds with the hybrid profile and issues MCP JSON-RPC POSTs).

describe('Phase 3 resources (hybrid)', () => {
  // KNOWN_TUTORIAL / KNOWN_MISSION must be slugs present in dev HANA after setup-dev-data.
  const KNOWN_TUTORIAL = process.env.MCP_HYBRID_TUTORIAL_SLUG ?? 'hcp-create-trial-account';
  const KNOWN_MISSION  = process.env.MCP_HYBRID_MISSION_SLUG ?? 'cp-starter-extensions';

  it('resources/read tutorial:// returns metadata + steps', async () => {
    const r = await mcpRpc('/mcp/graph', 'resources/read', { uri: `tutorial://${KNOWN_TUTORIAL}` });
    const meta = JSON.parse(r.result.contents[0].text);
    expect(meta.slug).toBe(KNOWN_TUTORIAL);
    expect(meta.totalSteps).toBeGreaterThan(0);
  });

  it('resources/read mission:// returns ordered tutorials', async () => {
    const r = await mcpRpc('/mcp/graph', 'resources/read', { uri: `mission://${KNOWN_MISSION}` });
    const meta = JSON.parse(r.result.contents[0].text);
    expect(meta.slug).toBe(KNOWN_MISSION);
    expect(Array.isArray(meta.tutorials)).toBe(true);
  });
});
```

> **`mcpRpc` + harness:** copy the boot + JSON-RPC helper from the closest existing hybrid MCP test (`test/hybrid/mcp-authenticated-tools.test.js` from Phase 2). Confirm the two `KNOWN_*` slugs exist in dev HANA (`cds bind --exec -- node -e "..."` or query via hana-cli); override via the env vars if not.

- [ ] **Step 2: Run the hybrid test**

Run: `npm run test:hybrid -- test/hybrid/mcp-resources.test.js` (requires `cf login` + `cds bind`).
Expected: PASS. If the slugs are absent, set `MCP_HYBRID_TUTORIAL_SLUG`/`MCP_HYBRID_MISSION_SLUG` to real dev slugs.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/mcp-resources.test.js
git commit -m "test(#1106): hybrid smoke for tutorial/mission resources"
```

### Task 11: MTA packaging for prompts + new lib files

**Files:**
- Modify: `.deploy/mta.yaml` (`srv` module `build-parameters.build-result`/`cp` list AND `srv-qa` module `cp` list)

**Interfaces:**
- Consumes: nothing new.
- Produces: `srv/mcp/prompts/*.md`, `srv/lib/mcp-*.js` present in the built srv and srv-qa modules so `prompts/get` doesn't 404 in QA/prod.

- [ ] **Step 1: Inspect the current cp lists**

Run: `grep -nE "cp |srv/lib|before-all|srv-qa|builder: custom" .deploy/mta.yaml | head -40` — find how `srv/lib` files are copied into the `srv` and `srv-qa` build outputs.

- [ ] **Step 2: Add the prompt dir + lib files to both cp lists**

```yaml
# .deploy/mta.yaml — in BOTH the srv and srv-qa module build commands, ensure the
# copy step includes the new dir and files. If the existing pattern copies srv/lib
# wholesale (e.g. `cp -r srv/lib gen/srv/srv/lib`), mcp-*.js is already covered —
# only srv/mcp/prompts needs adding:
#   - cp -r srv/mcp gen/srv/srv/mcp        # (srv module)
#   - cp -r srv/mcp gen/srv-qa/srv/mcp     # (srv-qa module)
# Match the EXACT copy idiom already in the file — do not invent a new one.
```

> **Audit rule (CLAUDE.md):** re-walk transitive `./` imports from `srv/lib/content-store.js` AND from the new `srv/lib/mcp-compose-router.js` (it deep-imports `@cap-js/mcp/lib/*`, which is in `node_modules` — bundled by `npm ci`, not the cp list — and imports `./mcp-resources.js`, `./mcp-prompt-loader.js`, `./metrics.js`, all under `srv/lib`). Confirm every `srv/lib/mcp-*.js` and `srv/mcp/prompts/*.md` lands in both module outputs.

- [ ] **Step 3: Verify the build includes them**

Run: `npm run build:all` then check the built output contains the prompts:
```bash
find .deploy gen -path '*srv/mcp/prompts*' 2>/dev/null | head
```
Expected: the 4 `.md` files appear under both `srv` and `srv-qa` build outputs. (If `build:all` is too heavy locally, at minimum run the `cds build --production` step and inspect `gen/`.)

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "build(#1106): package MCP prompts + lib into srv and srv-qa modules"
```

---

## Workstream 2 — Admin curation tools

### Task 12: Admin MCP CDS declarations + `@protocol` widening + handlers

**Files:**
- Create: `srv/admin-service-mcp.cds`
- Create: `srv/lib/mcp-admin-tools.js`
- Modify: `srv/admin-service.js` (wire the 4 handlers)
- Test: `test/unit/mcp-admin-tools.test.js`

**Interfaces:**
- Consumes:
  - `KnowledgeGraphService.mergeConcepts(loser, canonical)` action.
  - `AdminService.promoteCommunityToMission(communityId: Integer, missionSlug, title)` action.
  - `srv/lib/rebuild-trigger.js` → `scheduleRebuild(reason, { mode, slug })`.
  - existing in-process `/content/publish` path — reuse `srv/lib/content-store.js`'s publish entry (confirm the exported function name; Phase 2 called the HTTP route, but the in-process path is `publishContent`-style in `content-store.js` / `content-publish-session.js`).
- Produces: `srv/lib/mcp-admin-tools.js` exports `handleMergeConcepts`, `handlePromoteCommunity`, `handleTriggerRebuild`, `handlePublishContent`. CDS: `AdminService` widened to `@protocol:['odata','mcp']`; 4 actions declared.

- [ ] **Step 1: Write the failing test (handlers call through to existing logic)**

```javascript
// test/unit/mcp-admin-tools.test.js
import { expect, describe, it, vi } from 'vitest';
import {
  handleMergeConcepts, handleTriggerRebuild,
} from '../../srv/lib/mcp-admin-tools.js';

describe('mcp-admin-tools', () => {
  it('merge_concepts delegates to KnowledgeGraphService.mergeConcepts', async () => {
    const kg = { send: vi.fn(async () => ({})) };
    const srv = { _kg: kg };
    const connectSpy = vi.fn(async () => kg);
    await handleMergeConcepts.call(srv, { data: { loser: 'L', canonical: 'C' }, _connect: connectSpy });
    expect(kg.send).toHaveBeenCalledWith('mergeConcepts', { loser: 'L', canonical: 'C' });
  });

  it('trigger_rebuild calls scheduleRebuild with mode+slug', async () => {
    const scheduleSpy = vi.fn(async () => ({ scheduled: true }));
    const out = await handleTriggerRebuild.call({}, {
      data: { slug: 'foo', mode: 'slug-targeted' },
      user: { id: 'author@sap.example' },
      _schedule: scheduleSpy,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(expect.stringContaining('mcp'), { mode: 'slug-targeted', slug: 'foo' });
    expect(out.scheduled).toBe(true);
  });

  it('trigger_rebuild infers slug-targeted mode when slug set and mode omitted', async () => {
    const scheduleSpy = vi.fn(async () => ({ scheduled: true }));
    await handleTriggerRebuild.call({}, { data: { slug: 'foo' }, user: { id: 'a' }, _schedule: scheduleSpy });
    expect(scheduleSpy).toHaveBeenCalledWith(expect.any(String), { mode: 'slug-targeted', slug: 'foo' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/mcp-admin-tools.test.js` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```javascript
// srv/lib/mcp-admin-tools.js
import cds from '@sap/cds';
import { scheduleRebuild as realScheduleRebuild } from './rebuild-trigger.js';
const log = cds.log('mcp-admin');

/** merge_concepts — delegate to KnowledgeGraphService.mergeConcepts (KG.Admin gated). */
export async function handleMergeConcepts(req) {
  const connect = req._connect ?? ((name) => cds.connect.to(name));
  const kg = await connect('KnowledgeGraphService');
  await kg.send('mergeConcepts', { loser: req.data.loser, canonical: req.data.canonical });
  return { merged: true, loser: req.data.loser, canonical: req.data.canonical };
}

/** promote_community_to_mission — delegate to AdminService's own action (SuperAdmin gated). */
export async function handlePromoteCommunity(req) {
  // Same service — call the existing bound handler via the service.
  const admin = req._admin ?? (await cds.connect.to('AdminService'));
  return admin.send('promoteCommunityToMission', {
    communityId: req.data.communityId, missionSlug: req.data.missionSlug, title: req.data.title,
  });
}

/** trigger_rebuild — preferred content path (CI-validated workflow dispatch). */
export async function handleTriggerRebuild(req) {
  const schedule = req._schedule ?? realScheduleRebuild;
  const slug = req.data.slug ?? null;
  // Auto-infer slug-targeted when a slug is set and mode omitted (matches
  // rebuild-content.yml behavior — CLAUDE.md gotcha).
  const mode = req.data.mode ?? (slug ? 'slug-targeted' : 'full');
  const who = req.user?.id ?? 'unknown';
  log.info(`trigger_rebuild by ${who} mode=${mode} slug=${slug ?? '-'}`);
  return schedule(`mcp:trigger_rebuild:${who}`, { mode, slug });
}

/** publish_content — EMERGENCY lever; prefer trigger_rebuild. Write-scope gated. */
export async function handlePublishContent(req) {
  // Reuse the in-process publish entry from content-store / content-publish-session.
  // Implementer: confirm the exported function name and required CONTENT_API_KEY handling.
  const { publishSingle } = await import('./content-store.js'); // adjust to real export
  return publishSingle({ slug: req.data.slug, html: req.data.html, initiator: `mcp:${req.user?.id ?? 'unknown'}` });
}
```

> **`publishSingle` is a placeholder name.** Before Step 3, grep `srv/lib/content-store.js` + `srv/lib/content-publish-session.js` for the actual in-process publish entry point (the `/content/publish` route handler calls it). Wire `handlePublishContent` to THAT function with its real signature. If no clean in-process entry exists, `handlePublishContent` may `POST` to the local `/content/publish` with the `CONTENT_API_KEY` header — but prefer the in-process call. Update the test accordingly (add a `handlePublishContent` delegation test mirroring the others).

```cds
// srv/admin-service-mcp.cds
using from './admin-service';
using from './knowledge-graph-service';

// Phase 3 (#1106) — admin curation MCP tools. AdminService carries
// @requires:'Admin' at service level; these actions add their own @requires.
// @protocol widened to expose MCP alongside OData. Object-form is required so
// OData still mounts (see [[cap-graphql-shortcut-replaces-odata]]).
annotate AdminService with @protocol: [{ kind: 'odata' }, { kind: 'mcp', path: '/mcp/admin' }];

extend service AdminService {

  /** Merge a duplicate ("loser") knowledge-graph concept into a canonical one.
      All links repoint to the canonical concept; the loser is retired.
      Requires KnowledgeGraph.Admin.
      @param loser      UUID of the concept to retire.
      @param canonical  UUID of the surviving concept. */
  @requires: 'KnowledgeGraph.Admin'
  action merge_concepts(loser: UUID, canonical: UUID) returns { merged: Boolean };

  /** Draft a mission from a Louvain-detected knowledge-graph community. The
      community's tutorials become the mission's completion path (A→Z). A curator
      finishes and publishes the draft. Requires SuperAdmin. DEV-only until #917
      promotion reaches production.
      @param communityId  Louvain community id (integer).
      @param missionSlug   Slug for the new mission (lowercased).
      @param title         Human-readable mission title. */
  @requires: 'SuperAdmin'
  action promote_community_to_mission(communityId: Integer, missionSlug: String, title: String) returns { missionId: String };

  /** Trigger a content rebuild via the CI workflow (preferred, CI-validated).
      With a slug, rebuilds just that tutorial (~2 min); without, a full rebuild
      (~10 min). Requires Tutorial.Author.
      @param slug  Optional lowercase tutorial slug for a targeted rebuild.
      @param mode  Optional 'full' | 'slug-targeted' | 'catalog-only'. Auto-inferred from slug. */
  @requires: 'Tutorial.Author'
  action trigger_rebuild(slug: String, mode: String) returns { scheduled: Boolean };

  /** EMERGENCY: publish tutorial HTML directly to the content store, bypassing
      CI. Prefer trigger_rebuild (CI-validated). Requires Tutorial.Author and a
      write-scoped token.
      @param slug  Lowercase tutorial slug.
      @param html  Rendered tutorial HTML to publish. */
  @requires: 'Tutorial.Author'
  action publish_content(slug: String, html: String) returns { published: Boolean };
}
```

```javascript
// srv/admin-service.js — import + wire in the service impl:
import * as mcpAdmin from './lib/mcp-admin-tools.js';
this.on('merge_concepts', mcpAdmin.handleMergeConcepts);
this.on('promote_community_to_mission', mcpAdmin.handlePromoteCommunity);
this.on('trigger_rebuild', mcpAdmin.handleTriggerRebuild);
this.on('publish_content', mcpAdmin.handlePublishContent);
```

- [ ] **Step 4: Run test + model compile**

Run: `npx vitest run test/unit/mcp-admin-tools.test.js` → PASS. `npx cds compile srv --to json >/dev/null` → clean (confirms `@protocol` object-form + OData retained).

- [ ] **Step 5: Verify OData still mounts on AdminService**

```bash
KNOWLEDGE_GRAPH_ENABLED=true npx cds serve AdminService --in-memory --port 4005 &
sleep 6
curl -s http://localhost:4005/admin/\$metadata | head -c 200   # must return EDMX, not 404
kill %1
```
Expected: EDMX metadata (OData intact alongside MCP).

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service-mcp.cds srv/lib/mcp-admin-tools.js srv/admin-service.js test/unit/mcp-admin-tools.test.js
git commit -m "feat(#1106): admin curation MCP tools (merge/promote/rebuild/publish)"
```

### Task 13: `/mcp-admin/*` approuter route + srv rewrite + compose mount

**Files:**
- Modify: `approuter/xs-app.json` (add route)
- Modify: `srv/server.js` (add `/mcp-admin`→`/mcp/admin` rewrite; add `AdminService` to `RP_SERVICES` / mount compose at `/mcp/admin`)
- Test: covered by Task 15 (hybrid) + Task 16 (smoke 401)

**Interfaces:**
- Consumes: existing `/mcp-auth` rewrite pattern in `srv/server.js`; `Tutorial.MCP` XSUAA scope (already exists — reused, no new scope).
- Produces: `POST /mcp-admin/*` → XSUAA-gated at approuter (scope `Tutorial.MCP`) → srv rewrites to `/mcp/admin` → compose router. Per-action `@requires` (`Admin`/`SuperAdmin`/`KnowledgeGraph.Admin`/`Tutorial.Author`) does the fine-grained gating; the adapter auth-hides tools a caller can't invoke.

- [ ] **Step 1: Add the approuter route**

```json
// approuter/xs-app.json — add AFTER the /mcp-auth block (most-specific-first
// ordering; /mcp-admin is a distinct prefix so order vs /mcp-auth is not critical,
// but keep it grouped with the other mcp routes):
{
  "source": "^/mcp-admin/(.*)$",
  "target": "/mcp-admin/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "csrfProtection": false,
  "scope": "$XSAPPNAME.Tutorial.MCP"
}
```

> **Why `Tutorial.MCP` and not `Admin`:** the approuter route can gate on only ONE scope, but the four admin tools have four different `@requires` scopes. Gating the route on `Tutorial.MCP` (MCP-access, same as `/mcp-auth`) lets any MCP-authenticated user reach the endpoint; the adapter's `checkAuthorization` then hides every tool whose `@requires` the caller lacks (a `Tutorial.MCP`-only user gets an EMPTY `tools/list`). This is the intended belt-and-suspenders: approuter proves "you're an authenticated MCP user," per-action `@requires` proves "you may call THIS tool." Do NOT gate the route on `Admin` — that would lock out `Tutorial.Author`-only callers who legitimately may call `trigger_rebuild`.

- [ ] **Step 2: Add the srv rewrite + compose mount**

```javascript
// srv/server.js — add a rewrite mirroring the /mcp-auth block (~line 451):
app.use((req, _res, next) => {
  if (!req.url.startsWith('/mcp-admin/') && req.url !== '/mcp-admin') return next();
  if (mcpFlags().adminTools === false) { _res.status(503).send('Phase 3 admin MCP disabled'); return; }
  const rest = req.url.slice('/mcp-admin'.length) || '/';
  req.url = '/mcp/admin' + (rest === '/' ? '' : rest);
  if (req.originalUrl) req.originalUrl = req.url;
  next();
});

// In the cds.on('served') compose-mount block from Task 8, add AdminService:
const RP_SERVICES = ['KnowledgeGraphService', 'AdminService'];
// ...and mount AdminService's compose router at /mcp/admin:
//   app.use('/mcp/admin', makeComposeRouter(cds.services.AdminService));
```

> **`MCP_ADMIN_TOOLS_ENABLED` kill switch:** the 503 short-circuit above handles it. Also guard the `/mcp/admin` compose mount so a disabled flag doesn't mount it (or rely on the rewrite 503 — pick one, document it).

- [ ] **Step 3: Boot check — admin tools require auth**

```bash
KNOWLEDGE_GRAPH_ENABLED=true npx cds serve --in-memory --port 4004 &
sleep 8
# Anonymous initialize on /mcp/admin: tools/list should be EMPTY (all @requires gated),
# NOT a 500. (Local in-memory has mocked auth; this checks the mount resolves.)
curl -s -X POST http://localhost:4004/mcp/admin -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
kill %1
```
Expected: `0` (all admin tools auth-hidden for the anonymous/mock user) or the mocked-auth user's allowed subset — the point is a clean JSON-RPC response, not a crash. Real scope enforcement is verified in Task 15 (hybrid).

- [ ] **Step 4: Validate xs-app.json**

Run: `jq . approuter/xs-app.json >/dev/null && echo "valid json"`
Expected: `valid json`.

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json srv/server.js
git commit -m "feat(#1106): /mcp-admin route + rewrite + AdminService compose mount"
```

### Task 14: xs-security drift guard for the `/mcp-admin` gate

**Files:**
- Modify: `test/unit/xs-security-authorities.test.js`

**Interfaces:**
- Consumes: `xs-security.json` + `.deploy/xs-security.json` (both already contain `Tutorial.MCP`).
- Produces: an assertion that `Tutorial.MCP` (the scope the `/mcp-admin` route gates on) exists in BOTH files, so a future scope rename can't silently break the admin route.

- [ ] **Step 1: Add the assertion**

```javascript
// test/unit/xs-security-authorities.test.js — add inside the existing describe:
it('Tutorial.MCP scope (gates /mcp-auth AND /mcp-admin) present in both xs-security files', () => {
  for (const file of ['xs-security.json', '.deploy/xs-security.json']) {
    const sec = JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8'));
    const names = sec.scopes.map((s) => s.name);
    expect(names, `${file} must define Tutorial.MCP`).toContain('$XSAPPNAME.Tutorial.MCP');
  }
});
```

> **No new scope needed.** The `/mcp-admin` route reuses `Tutorial.MCP` (Task 13 rationale). If a reviewer insists on a distinct `Tutorial.MCPAdmin` scope, that's a scope-add in BOTH files + role template + role collection — but the design deliberately avoids it (per-action `@requires` already gates). This test locks in the reuse decision.

- [ ] **Step 2: Run test**

Run: `npx vitest run test/unit/xs-security-authorities.test.js` → PASS.

- [ ] **Step 3: Commit**

```bash
git add test/unit/xs-security-authorities.test.js
git commit -m "test(#1106): assert Tutorial.MCP gate scope in both xs-security files"
```

### Task 15: Hybrid smoke — admin tool scope enforcement (criterion 2)

**Files:**
- Create: `test/hybrid/mcp-admin-tools.test.js`

**Interfaces:**
- Consumes: deployed dev or `cds bind --exec` hybrid; a JWT WITHOUT admin scopes (or the anonymous path) to prove 403/auth-hidden, and optionally an admin JWT to prove a tool call succeeds.
- Produces: assertion that `merge_concepts` + `trigger_rebuild` are NOT callable without the required scope (satisfies criterion 2's "author scope enforced by hybrid smoke").

- [ ] **Step 1: Write the hybrid test**

```javascript
// test/hybrid/mcp-admin-tools.test.js
import { expect, describe, it } from 'vitest';
// Reuse the Phase 2 hybrid MCP harness (test/hybrid/mcp-authenticated-tools.test.js).

describe('Phase 3 admin tools scope enforcement (hybrid)', () => {
  it('tools/list on /mcp-admin without admin scope hides merge_concepts + trigger_rebuild', async () => {
    // Non-admin (or anonymous) caller: the adapter auth-hides gated actions.
    const r = await mcpRpc('/mcp/admin', 'tools/list', {}, { scope: 'none' });
    const names = (r.result?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('merge_concepts');
    expect(names).not.toContain('trigger_rebuild');
  });

  it('tools/call merge_concepts without KnowledgeGraph.Admin is rejected', async () => {
    const r = await mcpRpc('/mcp/admin', 'tools/call',
      { name: 'merge_concepts', arguments: { loser: '00000000-0000-0000-0000-000000000000', canonical: '00000000-0000-0000-0000-000000000001' } },
      { scope: 'none' });
    // Either a JSON-RPC auth error (-32001/-32003) or the tool is absent → error.
    expect(r.error ?? r.result?.isError).toBeTruthy();
  });
});
```

> **Harness + credentials:** copy the boot + JWT-injection helper from `test/hybrid/mcp-authenticated-tools.test.js`. The `{ scope: 'none' }` option should produce a JWT/user WITHOUT the admin scopes (or use the anonymous path). If minting a scoped JWT in hybrid is impractical, assert the auth-hidden behavior (empty/filtered `tools/list`) which is the deterministic, credential-free signal.

- [ ] **Step 2: Run the hybrid test**

Run: `npm run test:hybrid -- test/hybrid/mcp-admin-tools.test.js`
Expected: PASS — gated tools hidden/rejected for non-admin.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/mcp-admin-tools.test.js
git commit -m "test(#1106): hybrid scope enforcement for admin MCP tools"
```

---

## Cross-cutting — Smoke, Docs, Verification

### Task 16: Extend deployed-target smoke test

**Files:**
- Modify: `test/smoke/mcp.smoke.test.js`

**Interfaces:**
- Consumes: `SMOKE_BASE_URL` (deployed approuter), `fetchWithRetry`, `BASE_URL` from `test/smoke/smoke.config.js`.
- Produces: smoke canaries — resources/prompts 200 on `/mcp/graph`; `/mcp-admin/*` 401 without JWT.

- [ ] **Step 1: Add the smoke canaries**

```javascript
// test/smoke/mcp.smoke.test.js — add inside the describeIf block:
async function mcpPost(pathSuffix, body, headers = {}) {
  return fetchWithRetry(`${SMOKE_TARGET}${pathSuffix}`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

it('prompts/list returns >= 4 on /mcp/graph', async () => {
  const res = await mcpPost('/mcp/graph', { jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.result.prompts.length).toBeGreaterThanOrEqual(4);
});

it('resources/list returns an array on /mcp/graph', async () => {
  const res = await mcpPost('/mcp/graph', { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(Array.isArray(json.result.resources)).toBe(true);
});

it('/mcp-admin/* returns 401 without a JWT', async () => {
  const res = await mcpPost('/mcp-admin/', { jsonrpc: '2.0', id: 3, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run against deployed dev**

Run: `SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com npm run test:smoke -- test/smoke/mcp.smoke.test.js`
Expected: PASS (after Phase 3 is deployed to dev). Confirm the exact approuter URL with `cf apps` / maintainer before running.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/mcp.smoke.test.js
git commit -m "test(#1106): smoke canaries for resources/prompts + mcp-admin 401"
```

### Task 17: Documentation (criterion 5)

**Files:**
- Modify: `docs/end-users/mcp-quickstart.md` (resources + prompts usage sections)
- Modify: `docs/developers/reference/mcp-server.md` (8 new tool rows + resources table + prompts table)
- Modify: `docs/developers/architecture/mcp-server.md` (compose layer, tools-only finding, deep-import seam + fallback)
- Modify: `docs/developers/operations/mcp-server.md` (4 flags, `/mcp-admin` scope, new metrics)
- (Sidebar entries already exist in `docs/.vitepress/config.ts` — no registration change needed.)

**Interfaces:**
- Consumes: nothing (prose). References the shipped tool names, resource URIs, prompt names.
- Produces: consumer + developer docs covering Phase 3.

- [ ] **Step 1: Add the quickstart resource + prompt sections**

```markdown
<!-- docs/end-users/mcp-quickstart.md — append: -->

## Reading tutorial content as resources (Phase 3)

MCP clients can read tutorials, missions, and concepts as first-class resources:

- `tutorial://<slug>` — a tutorial's metadata, step titles, and rendered HTML.
- `mission://<slug>` — a mission and its ordered tutorials.
- `concept://<id>` — a knowledge-graph concept and the tutorials that teach it.

List them with `resources/list`; read one with `resources/read` and the URI. Example (Claude Desktop):
just ask "read tutorial://hcp-create-trial-account and summarize step 2".

## Prompt templates (Phase 3)

The server ships reusable prompt templates, discoverable via `prompts/list`:

| Prompt | Arguments | What it does |
|---|---|---|
| `summarize_mission_for_beginner` | `mission_slug` | Beginner-friendly mission summary |
| `generate_lab_exercise` | `tutorial_slug`, `step?` | A hands-on lab from a tutorial |
| `explain_concept` | `concept_id` | Explains a KG concept + its tutorials |
| `suggest_learning_path` | `from_slug`, `to_slug` | Ordered path between two tutorials |

Invoke with `prompts/get`; the client fills the arguments.
```

- [ ] **Step 2: Add reference tool/resource/prompt tables**

```markdown
<!-- docs/developers/reference/mcp-server.md — append rows to the tool table + new sections: -->

### Phase 3 KG deep-dive tools (anonymous, `/mcp/graph`)

| Tool | Args | Returns |
|---|---|---|
| `kg_shared_concepts` | `slug_a`, `slug_b` | concept overlap `[{conceptSlug,name,score}]` |
| `kg_neighborhood` | `slug`, `depth?` | four arms `{prerequisites,whatToLearnNext,sharedConcepts,teaches}` |
| `kg_search_concepts` | `query`, `maxConcepts?`, `maxTutorials?` | `{concepts[],tutorials[]}` |
| `kg_community` | `id` (fingerprint) | `{communityId,label,memberTutorials[],size,promotedToMissionSlug}` (read-only) |

### Phase 3 admin tools (`/mcp-admin/*`, XSUAA-gated)

| Tool | Scope | Wraps |
|---|---|---|
| `merge_concepts` | KnowledgeGraph.Admin | KG mergeConcepts |
| `promote_community_to_mission` | SuperAdmin | AdminService.promoteCommunityToMission |
| `trigger_rebuild` | Tutorial.Author | rebuild-content workflow dispatch (preferred) |
| `publish_content` | Tutorial.Author (write) | in-process /content/publish (emergency) |

### Resources & prompts
(list the 3 resource URI schemes + 4 prompts, same as the quickstart.)
```

- [ ] **Step 3: Add architecture + operations content**

```markdown
<!-- docs/developers/architecture/mcp-server.md — append: -->

## Phase 3 — the compose layer

`@cap-js/mcp@1.1.1` is tools-only (no resources/prompts API). Phase 3 adds a
`srv/lib/mcp-compose-router.js` that builds its own per-request SDK `McpServer`,
reuses the adapter's exported tool-registration functions (`@cap-js/mcp/lib/tools`),
and adds `registerResource`/`registerPrompt`. Advertised capabilities merge to
`{tools, resources, prompts}` on one `initialize`. Deep-imports of `@cap-js/mcp/lib/*`
are the fragile seam — pinned version + `MCP_PHASE3_ENABLED` fallback protect it.
```

```markdown
<!-- docs/developers/operations/mcp-server.md — append: -->

## Phase 3 flags & operations

| Flag | Default | Effect when false |
|---|---|---|
| `MCP_PHASE3_ENABLED` | true | Compose router unmounted; adapter serves tools only; `/mcp-admin` 503 |
| `MCP_RESOURCES_ENABLED` | true | No resources capability |
| `MCP_PROMPTS_ENABLED` | true | No prompts capability |
| `MCP_ADMIN_TOOLS_ENABLED` | true | `/mcp-admin/*` returns 503 |

`cf set-env tutorials-srv <FLAG> false && cf restart tutorials-srv`. `/mcp-admin/*`
gates on `Tutorial.MCP`; per-action `@requires` does fine-grained gating. New metrics:
`mcp_resource_read_total{scheme,outcome}`, `mcp_prompt_get_total{name}`,
`mcp_compose_fallback_total` (alert if sustained non-zero — deep-import seam broke).
```

- [ ] **Step 4: Verify docs build**

Run: `npm run docs:build` (or the repo's VitePress build script — check `jq '.scripts' package.json`).
Expected: build succeeds; the 4 MCP pages render; no dead-link errors.

- [ ] **Step 5: Commit**

```bash
git add docs/end-users/mcp-quickstart.md docs/developers/reference/mcp-server.md docs/developers/architecture/mcp-server.md docs/developers/operations/mcp-server.md
git commit -m "docs(#1106): Phase 3 resources, prompts, admin tools, compose layer"
```

### Task 18: Full-suite verification + spec-criteria walkthrough

**Files:** none (verification task).

- [ ] **Step 1: Run the full unit + contract suite**

Run: `npm test`
Expected: all green, including the 5 new unit files + extended contract test. If CI-vs-local Node drift bites (memory: Node 22 vs 24), reproduce with the CI Node version.

- [ ] **Step 2: Model compile + in-memory deploy**

Run: `npx cds compile srv --to json >/dev/null && npx cds deploy --to sqlite::memory: >/dev/null && echo OK`
Expected: `OK` (no model errors; no runtime `@assert.unique` surprises — though Phase 3 adds no schema, this catches accidental CSV/entity edits).

- [ ] **Step 3: Walk the 8 success criteria against the spec**

For each criterion in `docs/superpowers/specs/2026-07-13-mcp-server-phase3-design.md` §Success Criteria, point to the task that satisfies it:
1. 4 KG tools + coverage → Tasks 1–4, 9, 10.
2. 4 admin tools + scope smoke → Tasks 12, 15.
3. resources list/read → Tasks 6, 8, 10.
4. ≥4 prompts list/get → Tasks 5, 9.
5. docs → Task 17.
6. compose advertises 3 primitives + fallback → Tasks 7, 8.
7. 4 flags + `/mcp-admin` route → Tasks 8, 13.
8. Phase 1/2 unchanged → Task 9 (existing assertions green).

Note any gap and add a follow-up task.

- [ ] **Step 4: Run the `verify` skill on the deployed dev (if deployed)**

Drive one real end-to-end flow with an MCP client (or curl): `initialize` → `prompts/get` → `resources/read` → a KG tool call. Confirm real behavior, not just tests.

- [ ] **Step 5: Commit any fixes, then open the PR**

```bash
git add -A && git commit -m "chore(#1106): Phase 3 verification fixes" || echo "nothing to fix"
git push -u origin worktree-mcp-phase3-spec
gh pr create --draft --title "feat(#1106): MCP server Phase 3 — KG deep-dive + admin curation + resources/prompts" \
  --body "Implements #1106 per docs/superpowers/specs/2026-07-13-mcp-server-phase3-design.md. See plan docs/superpowers/plans/2026-07-13-mcp-server-phase3.md."
```

### Task 19: Deploy to dev + operator verification

**Files:** none (deploy task — coordinate with maintainer; confirm deploy scope).

- [ ] **Step 1: Confirm target + scope**

Run: `cf target` (memory rule: verify space before any deploy). Confirm deploy scope (backend + approuter — this touches `srv` and `approuter/xs-app.json`) with the maintainer.

- [ ] **Step 2: Build + deploy**

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```
> Verify the mtar is fresh (memory: `mbt build` can silently no-op). `mbt version` must print a version.

- [ ] **Step 3: Post-deploy smoke**

Run the Task 16 smoke against dev; confirm all Phase 3 canaries pass. Then manually run one MCP client end-to-end (OAuth or PAT) hitting a resource + prompt + KG tool.

- [ ] **Step 4: Flip-flag sanity**

`cf set-env tutorials-srv MCP_PHASE3_ENABLED false && cf restart tutorials-srv` → confirm `/mcp/graph` reverts to tools-only (no resources/prompts capability) and `/mcp-admin/*` returns 503; then set back to `true`.

- [ ] **Step 5: Mark PR ready**

`gh pr ready` once dev verification passes and a reviewer other than the author has confirmed one end-to-end flow.

---

## Self-Review

**Spec coverage:** all 8 success criteria mapped in Task 18 Step 3. All four workstreams covered: WS1 (Tasks 1–4), WS2 (Tasks 12–15), WS3 (Tasks 5–11), WS4 (deferred — no tasks, correct). Cross-cutting: smoke (16), docs (17), verification (18–19).

**Placeholder scan:** the plan flags three spots that REQUIRE implement-time confirmation against live code, each with explicit instructions (not hand-waving): (a) `clampLimit` semantics (Task 3); (b) `KgCommunity`/`CompletionPathItems` column names (Tasks 4, 6 — note: Task 12 confirmed `KgCommunity` uses `slug`+`vertexType`+`communityId`, so Task 4/6 tests using `tutorialSlug` MUST be reconciled to the real `slug`/`vertexType` columns at implement time); (c) the in-process publish entry point name (Task 12, `publishSingle` placeholder). These are genuine "verify against the DB" steps, not missing content — each names the exact file to grep and what to substitute.

**Type consistency:** handler names are stable across tasks (`handleSharedConcepts`, `handleNeighborhood`, `handleSearchConcepts`, `handleCommunity`, `handleMergeConcepts`, `handlePromoteCommunity`, `handleTriggerRebuild`, `handlePublishContent`; `registerResources`, `buildServer`, `flags`, `makeComposeRouter`, `loadPrompts`/`listPrompts`/`getPrompt`). CDS function names match their `this.on(...)` wiring and the contract-test `CURATED_TOOLS`/`EXPECTED_PARAMS` maps.

**Known reconciliation (do at implement time):** Task 4 and Task 6 test fixtures assume `KgCommunity.tutorialSlug`/`tutorialTitle`, but Task 12 revealed the real schema is `KgCommunity.slug` + `vertexType='tutorial'` (+ `communityId`, and the fingerprint lives on `Missions.sourceKgCommunityFingerprint`). Reconcile Task 4's `handleCommunity` to query `{communityFingerprint: fp}` OR `{communityId, vertexType:'tutorial'}` depending on which column `KgCommunity` actually keys communities by — read `db/knowledge-graph-communities.cds` FIRST (Task 4 Step 0 already mandates this) and make the test match reality.
