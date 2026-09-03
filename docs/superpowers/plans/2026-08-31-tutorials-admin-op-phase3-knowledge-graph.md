# Tutorials Admin OP — Phase 3 (Knowledge-Graph Facet) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-tutorial knowledge-graph data on the Tutorials Object Page — concepts taught (with confidence), PageRank importance, community label, and co-completed neighbor tutorials — all read-only from data already populated by nightly jobs.

**Architecture:** These entities (`TutorialConceptLinks`, `TutorialRank`, `CoCompletions`, `KgCommunity`/`KgCommunityLabel`) live on `KnowledgeGraphService`, not `AdminService`. Add `@readonly` projections on `AdminService` + associations from `Tutorials`, then a "Knowledge Graph" facet group. Purely additive and read-only; no pipeline changes. Reads fail-open (any SELECT throw leaves fields unset — FE renders nothing rather than 500), mirroring the existing KG `after('READ')` decorators.

**Tech Stack:** SAP CAP (Node.js, CDS), Fiori Elements annotations, Vitest. KG data populated by existing nightly jobs (PageRank #916, WCC #918, Louvain #917, community labels #1126).

**Spec:** `docs/superpowers/specs/2026-08-31-tutorials-admin-op-enhancements-design.md` (§WS4)

## Global Constraints

- **Read-only, additive** — `@readonly` projections; `@cds.redirection.target: false` (pattern `srv/admin-service.cds:114,120`) to avoid stealing redirects.
- **Fail-open reads** — if a KG projection can throw at read time, guard with an `after('READ')` that leaves fields unset (mirror `KnowledgeGraphService.Concepts`/`AdminService.Tutorials` isolation decorators). Pure associations/projections need no decorator.
- **No new env flags, no schema, no jobs** — data already materialized.
- **DEV-only until PROD KG data verifies** — same posture as #1126 (PROD Louvain/community data may be sparse; empty facets render as FE "No data", never a 500).
- **Namespace** — KG entities are in the `com.sap.developers.ims` model (via `db/knowledge-graph*.cds`); some carry `@cds.autoexpose:false` (e.g. `TutorialRank`) requiring explicit projection.
- **Tests:** `npm test` (unit), `npm run test:hybrid`. PR targets DEV.

## File Structure

- Modify: `srv/admin-service.cds` — `@readonly` projections (`TutorialConceptLinks`, `TutorialRank`, `CoCompletions`) + associations (`conceptLinks`, `rank`, `coCompletions`) on `Tutorials`; community label reachable via existing `KgCommunityMembers` (`:1249`) join.
- Modify: `srv/admin-service.js` — optional fail-open `after('READ','Tutorials')` if a computed field is added (community label flatten).
- Modify: `app/admin-annotations.cds` — Knowledge Graph facet group (concepts taught LineItem, prerequisites, PageRank + community FieldGroup, co-completed neighbors LineItem).
- Test: `test/unit/kg-exposure.test.js`, `test/unit/annotations-kg.test.js`, `test/hybrid/kg-facet.test.js`.

---

### Task 1: Expose read-only KG projections + associations

**Files:**
- Modify: `srv/admin-service.cds`
- Test: `test/unit/kg-exposure.test.js`

**Interfaces:**
- Consumes: `ims.TutorialConceptLinks` (`db/knowledge-graph.cds:61-70`, predicate teaches/extends + confidence), `ims.TutorialRank` (`:196-200`, PageRank score, `@cds.autoexpose:false`), `ims.CoCompletions` (`:158-162`, weighted A→B).
- Produces: `AdminService.TutorialConceptLinks`, `AdminService.TutorialRank`, `AdminService.CoCompletions` (`@readonly`); `Tutorials.conceptLinks` (many), `Tutorials.rank` (one), `Tutorials.coCompletions` (many).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/kg-exposure.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('KG exposure on AdminService', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('exposes concept links, rank, co-completions read-only', () => {
    expect(m.definitions['AdminService.TutorialConceptLinks']).toBeTruthy()
    expect(m.definitions['AdminService.TutorialRank']).toBeTruthy()
    expect(m.definitions['AdminService.CoCompletions']).toBeTruthy()
  })
  it('Tutorials carries conceptLinks / rank / coCompletions', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.conceptLinks).toBeTruthy()
    expect(t.rank).toBeTruthy()
    expect(t.coCompletions).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/kg-exposure.test.js --project unit` → FAIL.

> **Before implementing:** confirm exact entity + element names in `db/knowledge-graph.cds` — the join columns on `TutorialConceptLinks` (which side is the tutorial: `tutorial`/`source`), `TutorialRank` key/score field name (`score`/`pagerank`), and `CoCompletions` columns (`tutorialA`/`tutorialB`/`weight`). Adapt the `on` conditions below to the real names.

- [ ] **Step 3: Implement**

In `srv/admin-service.cds`:

```cds
@readonly @cds.redirection.target: false entity TutorialConceptLinks as projection on ims.TutorialConceptLinks;
@readonly @cds.redirection.target: false entity TutorialRank         as projection on ims.TutorialRank;
@readonly @cds.redirection.target: false entity CoCompletions        as projection on ims.CoCompletions;
```

Add to the `Tutorials` projection body (adapt `on` to confirmed column names):

```cds
conceptLinks  : Association to many TutorialConceptLinks on conceptLinks.tutorial = $self;
rank          : Association to one  TutorialRank         on rank.tutorial = $self;
coCompletions : Association to many CoCompletions        on coCompletions.tutorialA = $self;
```

> If `Tutorials.conceptLinks` is already injected on the db entity (`db/knowledge-graph.cds:94-97`), the `*` in the projection may already carry it — in that case only expose the target projection and drop the redundant association line. Verify with the failing test after each change.

- [ ] **Step 4: Run to verify it passes** — test PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds test/unit/kg-exposure.test.js
git commit -m "feat(admin): read-only KG projections + Tutorials associations (#WS4)"
```

### Task 2: Community label reachable on the OP

**Files:**
- Modify: `srv/admin-service.cds` (association to community membership/label) + optional `srv/admin-service.js` fail-open decorator
- Test: `test/unit/kg-community-link.test.js`

**Interfaces:**
- Consumes: `AdminService.KgCommunityMembers` (already exposed `:1249`), `KgCommunityLabel` (`db/knowledge-graph-communities.cds:76-83`, keyed by `communityFingerprint`).
- Produces: a way to show the tutorial's community label on the OP — either an association `communityMembership` on `Tutorials` (many, filtered to this tutorial's slug) rendered as a small LineItem, or a flattened `virtual communityLabel` populated fail-open in `after('READ','Tutorials')`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/kg-community-link.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('community label reachable', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('Tutorials exposes community membership or virtual label', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.communityMembership || t.communityLabel).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement (prefer the association — no compute, lowest risk)**

In `srv/admin-service.cds`, add an association from `Tutorials` to the exposed community-member rows for this tutorial's slug (adapt column names to `KgCommunityMembers`):

```cds
communityMembership : Association to many KgCommunityMembers on communityMembership.memberSlug = $self.slug;
```

> If `KgCommunityMembers` does not carry a `memberSlug`/label directly, add a `virtual communityLabel : String` and populate it fail-open in `srv/admin-service.js` `after('READ','Tutorials')`:
> ```js
> srv.after('READ', 'Tutorials', async (rows) => {
>   try { /* look up KgCommunity by slug → KgCommunityLabel; set r.communityLabel */ }
>   catch (e) { /* fail-open: leave unset */ }
> })
> ```
> Choose the association path if the columns allow; only fall back to the virtual+decorator if a join isn't expressible.

- [ ] **Step 4: Run to verify it passes** — → PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/kg-community-link.test.js
git commit -m "feat(admin): expose community membership/label on Tutorials (#WS4)"
```

### Task 3: UI — Knowledge Graph facet group

**Files:**
- Modify: `app/admin-annotations.cds`
- Test: `test/unit/annotations-kg.test.js`

**Interfaces:**
- Consumes: Task 1 + Task 2 associations/projections.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/annotations-kg.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('Knowledge Graph facets', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('OP facets include KG facets', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('ConceptsTaughtFacet')
    expect(ids).toContain('CoCompletionsFacet')
  })
  it('concept links LineItem shows predicate + confidence', () => {
    const li = m.definitions['AdminService.TutorialConceptLinks']['@UI.LineItem']
    const vals = li.map((x) => x.Value?.['='] || x.Value)
    expect(vals).toContain('predicate')
    expect(vals).toContain('confidence')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement**

In `app/admin-annotations.cds` (adapt element names to confirmed schema):

```cds
annotate AdminService.TutorialConceptLinks with @(
  UI.LineItem: [
    { Value: concept_ID, Label: 'Concept' },
    { Value: predicate,  Label: 'Relation' },   // teaches | extends
    { Value: confidence, Label: 'Confidence' }
  ]
);
annotate AdminService.CoCompletions with @(
  UI.LineItem: [
    { Value: tutorialB_ID, Label: 'Also Completed' },
    { Value: weight,       Label: 'Weight' }
  ]
);
```

Add a "Knowledge Graph" FieldGroup for PageRank + community, and facets to the winning `@UI.Facets` block:

```cds
annotate AdminService.Tutorials with @(
  UI.FieldGroup #KnowledgeGraph: { Data: [
    { Value: rank.score,       Label: 'PageRank' },
    { Value: communityLabel,   Label: 'Community' }   // or a nested membership ref
  ]}
);
// facets:
{ $Type: 'UI.ReferenceFacet', Label: 'Knowledge Graph', ID: 'KgFieldsFacet', Target: '@UI.FieldGroup#KnowledgeGraph' },
{ $Type: 'UI.ReferenceFacet', Label: 'Concepts Taught', ID: 'ConceptsTaughtFacet', Target: 'conceptLinks/@UI.LineItem' },
{ $Type: 'UI.ReferenceFacet', Label: 'Co-Completed', ID: 'CoCompletionsFacet', Target: 'coCompletions/@UI.LineItem' },
```

> `rank.score` path-navigation in a FieldGroup requires the to-one `rank` association from Task 1; if FE rejects the deep path, expose a flattened `virtual pageRank : Decimal` on `Tutorials` populated fail-open in `after('READ')` instead.

- [ ] **Step 4: Run to verify it passes** — → PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds test/unit/annotations-kg.test.js
git commit -m "feat(admin-ui): Knowledge Graph facet (concepts/PageRank/community/co-completions) (#WS4)"
```

### Task 4: Hybrid guard — KG facet reads fail-open

**Files:**
- Test: `test/hybrid/kg-facet.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/kg-facet.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('KG facet reads (hybrid)', () => {
  let admin; beforeAll(async () => { admin = await cds.connect.to('AdminService') })
  it('reads a tutorial with KG associations expanded without error', async () => {
    const t = await admin.run(SELECT.one.from('AdminService.Tutorials').columns('ID','slug'))
    expect(t).toBeTruthy()
    const links = await admin.run(SELECT.from('AdminService.TutorialConceptLinks').where({ tutorial_ID: t.ID }))
    expect(Array.isArray(links)).toBe(true)          // may be empty in DEV — that's fine
    const co = await admin.run(SELECT.from('AdminService.CoCompletions').limit(1))
    expect(Array.isArray(co)).toBe(true)
  })
})
```

- [ ] **Step 2: Run** `npm run test:hybrid -- test/hybrid/kg-facet.test.js` → PASS (empty arrays acceptable).
- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-facet.test.js
git commit -m "test(kg): hybrid guard for KG facet reads (#WS4)"
```

---

## Final verification

- [ ] `npm test` all green; `npx cds deploy --to sqlite::memory:` clean.
- [ ] DEV post-deploy: reference tutorial OP shows a Knowledge Graph facet — concepts taught with confidence, PageRank + community label, co-completed neighbors. Empty sections render as FE "No data" (never a 500).
- [ ] PR targets DEV. Note: DEV-only until PROD Louvain/community data verifies (#1126 posture).

## Self-review notes

- **Spec coverage:** WS4 concepts/prerequisites (Task 1/3), PageRank (Task 1/3), community label (Task 2/3), co-completed neighbors (Task 1/3).
- **Verify against live code before writing each task:** exact `TutorialConceptLinks` join column (`tutorial` vs `source`) + `predicate`/`confidence` names; `TutorialRank` score field name; `CoCompletions` column names (`tutorialA`/`tutorialB`/`weight`); whether `Tutorials.conceptLinks` is already carried via the db-entity injection (`db/knowledge-graph.cds:94-97`); whether `KgCommunityMembers` exposes a slug/label to associate on. Each is grounded by the inventory research but must be confirmed at the touched lines. Prefer associations over computed virtuals; only add a fail-open `after('READ')` decorator where a join isn't expressible.
