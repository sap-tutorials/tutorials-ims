# Publish-to-HANA Throughput Optimizations (#2802) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut unscoped content-rebuild publish time by skipping the ~95–106s concept-render phase when nothing concept-relevant changed, re-composing (not re-rendering) concepts on shell-only changes, and batching the per-row N+1 metadata upserts.

**Architecture:** Finding 1 adds a two-level concept-phase delta — a phase-level skip gated on a cheap concept-input digest + a shell hash (stored on `ContentManifest`), plus a per-concept `bodyHash` column enabling shell-only re-compose. Finding 2 converts four per-slug SELECT-then-UPDATE-or-INSERT loops into batched `WHERE slug IN (chunk)` reads + grouped writes. Finding 3 folds a duplicate pre-session GET and files a sibling issue for the image-refresh outlier.

**Tech Stack:** SAP CAP (Node.js), CDS QL + raw `db.run` (HANA + SQLite), Vitest, `@sap/cds`.

**Spec:** `docs/superpowers/specs/2026-10-16-publish-throughput-2802-design.md`

## Global Constraints

- Target branch is **DEV** (never `main`); PR, do not direct-merge. (CLAUDE.md / memory.)
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — use raw `db.run` for BLOB reads (`srv/lib/content-store.js` precedent). CDS QL BLOB reads are fine on SQLite unit tests only.
- **`WHERE slug IN (...)` chunk size = 500** for scalar-only selects (HANA packet cap, per `cqn-where-in-hana-packet-cap.md`; precedent `content-publish-session.js:264,545,1564`). Drop to 50 only if the select also materializes `content`/`sourceContent` BLOBs.
- Schema additions must be **nullable + additive** (no data migration); NULL = "no prior data, don't skip / always render" (back-compat posture mirrors `sourceHash`, `_content-shape.cds:37-39`).
- Shared aspects in `db/_content-shape.cds` emit under both prod (`db/`) and QA (`db-qa/`) namespaces — one aspect edit covers both channels.
- **Fail-open everywhere in Finding 1:** any error computing/comparing a token or hash falls through to the current full render path. Never skip on uncertainty.
- The CDS model currently fails to compile on this branch (`srv/developer-service-mcp.cds:15` duplicate `get_my_tutorials`) — pre-existing, unrelated. Unit tests run via Vitest against the test model; if a task needs `cds` compile, note it, do not fix that duplicate here.

## Review Focus

- **Stale chrome on shell-only change:** if the concept phase skips while `__shell__` changed, carry-forward copies the prior composed BLOB verbatim (old CSS/island refs) → served concept pages ship stale chrome. The phase skip MUST require shellHash unchanged. (Task 4 tests this.)
- **Carry-forward disabled path:** when `isDeltaSkipCarryForward()` is ON, skipped concepts are NOT carried forward (reads come from `ContentCurrent`); the phase skip must not fire unless the concept keys are guaranteed present at the new version. (Task 4 tests both flag states.)
- **First publish after migration:** `bodyHash`/`conceptPhaseToken` NULL on all prior rows → must render fully (no skip), seeding values for next run. (Tasks 2 & 4 test NULL.)
- **`CommunityEventConceptLinks` has no `modifiedAt`:** the digest must use `max(extractedAt)+count(*)` for it, not `modifiedAt`, or it throws and (fail-open) never skips. (Task 3 tests the digest includes it without error.)
- **F2 row-equivalence:** batched upserts must write byte-identical rows (same values, same insert-vs-update decision) as the per-row path, including the case-insensitive LOWER(slug) match and the nested Steps upsert. (Tasks 6–9 assert pre/post equivalence.)

---

## Finding 1 — Concept-phase delta (Tasks 1–5)

### Task 1: Schema — add `bodyHash` + `conceptPhaseToken` columns

**Files:**
- Modify: `db/_content-shape.cds` (ContentFilesAspect, ContentCurrentAspect, ContentHistoryAspect, ContentManifestAspect)
- Test: `test/unit/content-schema-columns.test.js` (new)

**Interfaces:**
- Produces: `ContentFiles.bodyHash : Sha256`, `ContentCurrent.bodyHash`, `ContentHistory.bodyHash`, `ContentManifest.conceptPhaseToken : String(64)` — all nullable.

- [ ] **Step 1: Write the failing test** — assert the columns exist in the compiled model.

```js
// test/unit/content-schema-columns.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('content schema #2802 columns', () => {
  let m;
  beforeAll(async () => { m = await cds.load('db/_content-shape.cds'); });
  const el = (ent) => cds.linked(m).definitions[`com.sap.developers.ims.shared.${ent}`].elements;
  it('ContentFilesAspect has bodyHash', () => expect(el('ContentFilesAspect').bodyHash).toBeDefined());
  it('ContentCurrentAspect has bodyHash', () => expect(el('ContentCurrentAspect').bodyHash).toBeDefined());
  it('ContentHistoryAspect has bodyHash', () => expect(el('ContentHistoryAspect').bodyHash).toBeDefined());
  it('ContentManifestAspect has conceptPhaseToken', () => expect(el('ContentManifestAspect').conceptPhaseToken).toBeDefined());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-schema-columns.test.js`
Expected: FAIL — `bodyHash` undefined.

- [ ] **Step 3: Add the columns**

In `db/_content-shape.cds`, add to `ContentFilesAspect` (after `sourceRepo`, ~line 43), `ContentCurrentAspect` (after `sourceVersion`, ~line 90), and `ContentHistoryAspect` (after its `sourceCommit`):
```cds
  // #2802 — per-concept body-only hash (excludes __shell__ chrome). Publish-only
  // metadata; the serve path never reads it. Nullable: pre-#2802 rows have none,
  // and a null forces a full concept render (no shell-only re-compose shortcut).
  bodyHash                  : Sha256;
```
Add to `ContentManifestAspect` (after `pipelineToken`, ~line 72):
```cds
  // #2802 — sha256(conceptInputDigest + shellHash) at commit. If the next publish
  // computes the same token AND the shell is unchanged, the render-concepts phase
  // is skipped entirely (concepts carried forward). Null on pre-#2802 manifests.
  conceptPhaseToken         : String(64);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/content-schema-columns.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add db/_content-shape.cds test/unit/content-schema-columns.test.js
git commit -m "feat(content): add bodyHash + conceptPhaseToken columns (#2802)"
```

---

### Task 2: `renderConceptDetail` body-hash — compute & store `bodyHash` per concept

**Files:**
- Modify: `srv/lib/publish-concepts.js` (render loop `:111-133`, append `:142-148`)
- Test: `test/unit/publish-concepts-bodyhash.test.js` (new)

**Interfaces:**
- Consumes: `renderConceptDetail(concept, raw) -> { body }` (existing), `composeShell(shell, body, meta)` (existing).
- Produces: each appended concept file now carries a `bodyHash` = `sha256(body + '\u0000' + JSON.stringify(meta))`; the append payload gains a parallel `bodyHashes: { [key]: hash }` map passed through to `appendToSession`.

- [ ] **Step 1: Write the failing test** — a concept whose body is identical but shell differs yields the SAME bodyHash; different body yields a different one.

```js
// test/unit/publish-concepts-bodyhash.test.js
import { describe, it, expect } from 'vitest';
import { computeConceptBodyHash } from '../../srv/lib/publish-concepts.js';

describe('computeConceptBodyHash', () => {
  const meta = { kind: 'concept', slug: 'abap', title: 'ABAP', description: 'd' };
  it('is stable for identical body+meta', () => {
    expect(computeConceptBodyHash('BODY', meta)).toBe(computeConceptBodyHash('BODY', meta));
  });
  it('ignores shell (body-only input)', () => {
    // same body, caller composes shell separately — hash must not see shell
    expect(computeConceptBodyHash('BODY', meta)).not.toBe(computeConceptBodyHash('BODY2', meta));
  });
  it('changes when meta changes', () => {
    expect(computeConceptBodyHash('BODY', meta)).not.toBe(computeConceptBodyHash('BODY', { ...meta, title: 'X' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/publish-concepts-bodyhash.test.js`
Expected: FAIL — `computeConceptBodyHash` not exported.

- [ ] **Step 3: Implement + export `computeConceptBodyHash`, wire into the loop**

In `srv/lib/publish-concepts.js`, add near the top-level helpers:
```js
export function computeConceptBodyHash(body, meta) {
  return createHash('sha256').update(`${body}\u0000${JSON.stringify(meta)}`, 'utf-8').digest('hex');
}
```
In `renderConceptsIntoSession`, inside the loop (after `const fullDoc = composeShell(...)`, `:121`), compute and track the body hash alongside the existing full-doc hash:
```js
      const bodyHash = computeConceptBodyHash(body, meta);
      // ... existing contentHash + priorHashes skip unchanged ...
      changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
      bodyHashes[key] = bodyHash; // new map declared next to changedFiles
```
Declare `const bodyHashes = {};` next to `const changedFiles = {};` (`:107`). In the append batch loop (`:143-148`), pass the matching slice of `bodyHashes` through: `await helpers.appendToSession({ sessionId, files, bodyHashes: pick(bodyHashes, slice) });` (add a tiny local `pick(obj, keys)` helper).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/publish-concepts-bodyhash.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/publish-concepts.js test/unit/publish-concepts-bodyhash.test.js
git commit -m "feat(publish): compute per-concept bodyHash in render phase (#2802)"
```

---

### Task 3: `conceptInputDigest` — cheap concept-corpus change signal

**Files:**
- Create: `srv/lib/concept-input-digest.js`
- Test: `test/unit/concept-input-digest.test.js` (new)

**Interfaces:**
- Produces: `computeConceptInputDigest(db, namespace) -> Promise<string>` — sha256 over `max(modifiedAt)` + `count(*)` of each concept/link table (using `max(extractedAt)` for `CommunityEventConceptLinks`, and base `Concepts` with the publish gate for the published-concept set). Deterministic; throws on query error (caller fails open).

- [ ] **Step 1: Write the failing test** — digest is stable across calls on identical data and changes when a probe value changes (mock the aggregate reads).

```js
// test/unit/concept-input-digest.test.js
import { describe, it, expect, vi } from 'vitest';
import { digestFromProbes } from '../../srv/lib/concept-input-digest.js';

describe('digestFromProbes', () => {
  const base = [{ t: 'Concepts', max: '2026-10-01T00:00:00Z', n: 5946 }, { t: 'ConceptEdges', max: '2026-09-30T00:00:00Z', n: 12000 }];
  it('is stable for identical probes', () => expect(digestFromProbes(base)).toBe(digestFromProbes(base)));
  it('changes when a count changes', () => {
    const bumped = [{ ...base[0], n: 5947 }, base[1]];
    expect(digestFromProbes(bumped)).not.toBe(digestFromProbes(base));
  });
  it('changes when a max timestamp changes', () => {
    const bumped = [{ ...base[0], max: '2026-10-02T00:00:00Z' }, base[1]];
    expect(digestFromProbes(bumped)).not.toBe(digestFromProbes(base));
  });
  it('is order-independent', () => expect(digestFromProbes([base[1], base[0]])).toBe(digestFromProbes(base)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/concept-input-digest.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the digest**

```js
// srv/lib/concept-input-digest.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';

// Pure, testable core: canonicalize probe rows (sort by table name) → sha256.
export function digestFromProbes(probes) {
  const canon = [...probes]
    .map(p => ({ t: p.t, max: p.max ?? '', n: p.n ?? 0 }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .map(p => `${p.t}:${p.max}:${p.n}`)
    .join('|');
  return createHash('sha256').update(canon, 'utf-8').digest('hex');
}

// Each entry: [tableLogicalName, entityRef, tsColumn, extraWhere?]
// CommunityEventConceptLinks has no `managed` → use extractedAt.
// Published concepts: aggregate base Concepts with the publish gate.
export async function computeConceptInputDigest(db, namespace) {
  const ims = cds.entities(namespace);
  const ext = cds.entities(`${namespace}.external`);
  const probes = [];
  const probe = async (t, ent, tsCol, where) => {
    let q = SELECT.one.from(ent).columns(`max(${tsCol}) as mx`, 'count(*) as n');
    if (where) q = q.where(where);
    const r = await db.run(q);
    probes.push({ t, max: r?.mx ? String(r.mx) : '', n: Number(r?.n ?? 0) });
  };
  await probe('Concepts', ims.Concepts, 'modifiedAt', { publishedAt: { '!=': null }, status: 'ACTIVE' });
  await probe('ConceptEdges', ims.ConceptEdges, 'modifiedAt');
  await probe('TutorialConceptLinks', ims.TutorialConceptLinks, 'modifiedAt');
  await probe('LearningJourneyConceptLinks', ext.LearningJourneyConceptLinks, 'modifiedAt');
  await probe('BlogPostConceptLinks', ext.BlogPostConceptLinks, 'modifiedAt');
  await probe('DiscoveryMissionConceptLinks', ext.DiscoveryMissionConceptLinks, 'modifiedAt');
  await probe('VideoConceptLinks', ext.VideoConceptLinks, 'modifiedAt');
  await probe('ApiDocConceptLinks', ext.ApiDocConceptLinks, 'modifiedAt');
  await probe('SampleConceptLinks', ext.SampleConceptLinks, 'modifiedAt');
  await probe('HelpDocConceptLinks', ext.HelpDocConceptLinks, 'modifiedAt');
  await probe('CommunityEventConceptLinks', ext.CommunityEventConceptLinks, 'extractedAt'); // no managed
  await probe('CommunityEvents', ext.CommunityEvents, 'modifiedAt');
  return digestFromProbes(probes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/concept-input-digest.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/concept-input-digest.js test/unit/concept-input-digest.test.js
git commit -m "feat(publish): add conceptInputDigest change signal (#2802)"
```

---

### Task 4: Phase-level skip + shell-only re-compose in render-concepts

**Files:**
- Modify: `srv/lib/publish-concepts.js` (`renderConceptsIntoSession` `:95-156`, `renderConceptsHandler` `:190-205`, `loadPriorConceptHashes` `:176-188`)
- Test: `test/unit/publish-concepts-phase-skip.test.js` (new)

**Interfaces:**
- Consumes: `computeConceptInputDigest` (Task 3), `computeConceptBodyHash` (Task 2), `shell` `{before,after}`, prior `conceptPhaseToken` from ACTIVE `ContentManifest`.
- Produces: `renderConceptsIntoSession` returns `{ conceptsSeen, conceptsChanged, conceptsSkipped, conceptsErrored, conceptsRecomposed, phaseSkipped, conceptPhaseToken, durationMs }`. New arg: `priorBodyHashes` (map `concept-<slug>` → prior `bodyHash`), `priorPhaseToken` (string|null), `carryForwardActive` (bool).

- [ ] **Step 1: Write the failing tests** — three behaviors: (a) phase skip when token matches AND shell unchanged AND carry-forward active; (b) NO skip when shell changed even if digest matches; (c) shell-only re-compose path increments `conceptsRecomposed` and does not call `renderConceptDetail`.

```js
// test/unit/publish-concepts-phase-skip.test.js
import { describe, it, expect, vi } from 'vitest';
import * as mod from '../../srv/lib/publish-concepts.js';

const shell = { before: '<html><head>CSS1</head><body>', after: '</body></html>' };
const shell2 = { before: '<html><head>CSS2</head><body>', after: '</body></html>' };

describe('render-concepts phase skip', () => {
  it('skips the whole phase when phaseToken matches, shell unchanged, carry-forward active', async () => {
    const buildConceptsPayload = vi.fn(); // must NOT be called on skip
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'TOKEN', carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(true);
    expect(buildConceptsPayload).not.toHaveBeenCalled();
  });
  it('does NOT skip when the shell changed (token would differ)', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell: shell2,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'DIFFERENT', carryForwardActive: true,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(false);
    expect(buildConceptsPayload).toHaveBeenCalled();
  });
  it('does NOT skip when carry-forward is disabled', async () => {
    const buildConceptsPayload = vi.fn().mockResolvedValue({ concepts: [] });
    const r = await mod.renderConceptsIntoSession({
      db: {}, sessionId: 's', helpers: { appendToSession: vi.fn() }, shell,
      priorPhaseToken: 'TOKEN', computedPhaseToken: 'TOKEN', carryForwardActive: false,
      deps: { buildConceptsPayload, computeConceptInputDigest: async () => 'DIGEST' },
    });
    expect(r.phaseSkipped).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/publish-concepts-phase-skip.test.js`
Expected: FAIL — new args/branches absent; `phaseSkipped` undefined.

- [ ] **Step 3: Implement the skip + re-compose**

In `renderConceptsIntoSession` (`:95`), BEFORE `buildConceptsPayload`:
```js
  // #2802 Level-1 phase skip: shell + concept inputs unchanged AND concepts will
  // be carried forward → skip the whole phase (no 12-table scan, no render loop).
  const computedPhaseToken = args.computedPhaseToken
    ?? sha256(`${await (deps.computeConceptInputDigest || computeConceptInputDigest)(db, args.namespace)}\u0000${shellHash(shell)}`);
  if (args.priorPhaseToken && args.priorPhaseToken === computedPhaseToken && args.carryForwardActive) {
    return { conceptsSeen: 0, conceptsChanged: 0, conceptsSkipped: 0, conceptsErrored: 0,
             conceptsRecomposed: 0, phaseSkipped: true, conceptPhaseToken: computedPhaseToken,
             durationMs: Date.now() - started };
  }
```
Add `shellHash({before,after})` = `sha256(before + '\u0000' + after)`. In the loop, when `priorBodyHashes[key] === bodyHash` but the composed `contentHash` differs (shell moved), still re-compose from the just-rendered `body` but increment `conceptsRecomposed` instead of a full re-render — note the body render already happened; the *saving* for the common case is the phase skip (Level 1). (Level-2 "skip renderConceptDetail" optimization: when `priorBodyHashes[key] === bodyHash`, skip calling `renderConceptDetail` and re-compose from a carried body — only wire this if the carried body is retrievable; otherwise the phase skip already covers the dominant case. Keep this branch behind the same fail-open guard.) Return `computedPhaseToken` in the result. Update `renderConceptsHandler` to load `priorPhaseToken` (from ACTIVE `ContentManifest.conceptPhaseToken`), `priorBodyHashes` (extend `loadPriorConceptHashes` to also select `bodyHash`), and `carryForwardActive` (`!isDeltaSkipCarryForward()`), and pass them in.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/publish-concepts-phase-skip.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/publish-concepts.js test/unit/publish-concepts-phase-skip.test.js
git commit -m "feat(publish): phase-level concept skip + shell-aware guard (#2802)"
```

---

### Task 5: Persist `conceptPhaseToken` at commit; thread `bodyHash` through append

**Files:**
- Modify: `packages/content/content-publish-session.js` (`appendToSession` entries `:213-247`, `commitSession` manifest UPDATE `:596-615`)
- Test: `test/unit/content-publish-session-phasetoken.test.js` (new) + extend an existing append suite

**Interfaces:**
- Consumes: `appendToSession({ sessionId, files, bodyHashes? })` (Task 2 passes `bodyHashes`); the render-concepts phase result's `conceptPhaseToken` (Task 4).
- Produces: `ContentFiles.bodyHash` written per entry; `ContentManifest.conceptPhaseToken` set at commit.

- [ ] **Step 1: Write the failing test** — appending a file with a `bodyHashes` entry stores it on the row; committing records the phase token on the manifest. (SQLite in-memory.)

```js
// test/unit/content-publish-session-phasetoken.test.js — sketch
// begin → append({files:{'concept-x': gz}, bodyHashes:{'concept-x':'BH'}}) → assert ContentFiles row bodyHash==='BH'
// set phase token on commit → assert ContentManifest.conceptPhaseToken persisted
```
(Fill with the project's existing publish-session test harness pattern — see `test/` content-delta suites for begin/append/commit setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-publish-session-phasetoken.test.js`
Expected: FAIL — `bodyHash` not persisted / `conceptPhaseToken` null.

- [ ] **Step 3: Implement**

In `appendToSession`, where entries are built (`:213-247`), add `bodyHash: bodyHashes?.[slug] ?? null` to each pushed entry. In `commitSession`, when flipping the new manifest to ACTIVE (`:596-615`), include `conceptPhaseToken` in the `.set(...)` — value threaded from the render-concepts phase result (store it on the session/manifest during the phase, mirroring how `pipelineToken` is handled at `:614`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/content-publish-session-phasetoken.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/content/content-publish-session.js test/unit/content-publish-session-phasetoken.test.js
git commit -m "feat(publish): persist bodyHash + conceptPhaseToken (#2802)"
```

---

## Finding 2 — Batch N+1 upserts (Tasks 6–9)

Each task: write a row-equivalence test that runs the function against an in-memory SQLite DB seeded with a known state, snapshots the resulting rows, then (after the refactor) asserts identical rows. Chunk `WHERE slug IN` by **500** (scalar only).

### Task 6: Batch `upsertBodyTexts`

**Files:**
- Modify: `packages/content/content-publish-session.js:1251-1278`
- Test: `test/unit/upsert-bodytexts-batch.test.js` (new)

**Interfaces:**
- Signature unchanged: `upsertBodyTexts(namespace, bodyTexts)`.

- [ ] **Step 1: Write the failing test** — seed TutorialBodyText with one existing slug; call with that slug (update) + a new slug (insert); assert both rows correct. Add a `vi.spyOn(db,'run')` call-count assertion: ≤ 3 statements total for 2 slugs (1 batched SELECT + 1 batched INSERT + 1 grouped UPDATE), not 2×(SELECT+write).

```js
// assert after: rows === [{slug:'a',bodyText:'A2'},{slug:'b',bodyText:'B'}] and runCount <= 3
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run test/unit/upsert-bodytexts-batch.test.js` — Expected: FAIL on the run-count assertion (current code is N+1).

- [ ] **Step 3: Implement batch** — one `SELECT.from(TutorialBodyText).where({ slug: { in: chunk } }).columns('slug')` per 500-chunk → Set of existing; partition entries into inserts (multi-row `INSERT.into(TutorialBodyText).entries(...)`) and updates (grouped `UPDATE` per slug, or a single `UPSERT` if the dialect supports it — keep UPDATE loop over the small changed set for parity).

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/content/content-publish-session.js test/unit/upsert-bodytexts-batch.test.js
git commit -m "perf(publish): batch upsertBodyTexts reads/writes (#2802)"
```

### Task 7: Batch `upsertBranchSpecs`

**Files:** Modify `content-publish-session.js:1280-1317`; Test `test/unit/upsert-branchspecs-batch.test.js` (new).
**Interfaces:** `upsertBranchSpecs(namespace, branchSpecs)` unchanged.

- [ ] **Step 1:** Failing test — seed one BranchSpecs row; call with update+insert; assert `branchPoints`/`skipPoints` JSON correct for both and run-count ≤ 3.
- [ ] **Step 2:** Run → FAIL on run-count. `npx vitest run test/unit/upsert-branchspecs-batch.test.js`
- [ ] **Step 3:** Batch exactly as Task 6 (SELECT slug IN 500-chunk → partition → multi-row INSERT + grouped UPDATE), preserving `JSON.stringify` of branch/skip points.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `perf(publish): batch upsertBranchSpecs reads/writes (#2802)`.

### Task 8: Batch `upsertTutorialMetadata` (Tutorials + Steps + TutorialMeta)

**Files:** Modify `content-publish-session.js:805-973`; Test `test/unit/upsert-tutorial-metadata-batch.test.js` (new).
**Interfaces:** `upsertTutorialMetadata(namespace, metadata) -> { tutorialIds }` unchanged.

- [ ] **Step 1: Failing test** — seed 2 tutorials (1 existing w/ steps, 1 new); assert Tutorials/Steps/TutorialMeta rows identical to the per-row path, the case-insensitive LOWER(slug) match still resolves the existing tutorial, and run-count drops materially (assert the batched SELECT shape: one slug-IN lookup, one Steps lookup across the batch, not per-slug).
- [ ] **Step 2:** Run → FAIL. `npx vitest run test/unit/upsert-tutorial-metadata-batch.test.js`
- [ ] **Step 3: Implement** — Batch the three reads with `WHERE LOWER(slug) IN (chunk)` for Tutorials (raw `db.run`, 500-chunk, mirror `recomputeProgressForChangedTutorials:1564` incl. its positional-bind→inline-literal fallback), `WHERE tutorial_ID IN (ids)` for Steps and TutorialMeta → Maps. Allocate `legacyId` via one `max()` + in-memory increment instead of per-row `getNextLegacyId`. Partition into multi-row INSERTs + grouped UPDATEs. Preserve exact column sets listed in the explorer report (Tutorials: ID,slug,title,description,averageTimeToComplete,experienceTag,primaryTag,stepCount,status,legacyId; Steps: ID,tutorial_ID,stepOrder,title,status,legacyId; TutorialMeta cols likewise).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `perf(publish): batch upsertTutorialMetadata (#2802)`.

### Task 9: Batch `linkTutorialAuthorship`

**Files:** Modify `content-publish-session.js:1013-1249`; Test `test/unit/link-authorship-batch.test.js` (new).
**Interfaces:** `linkTutorialAuthorship(namespace, metadata)` unchanged (exported).

- [ ] **Step 1: Failing test** — seed Users/Tutorials/TutorialContributors/TutorialMeta; call with 2 slugs; assert author_ID, contributor user_ID links, and TutorialMeta owner/ownerEmail resolve identically to the per-row path (including the `WHERE ... IS NULL` conditional-update semantics), run-count reduced.
- [ ] **Step 2:** Run → FAIL. `npx vitest run test/unit/link-authorship-batch.test.js`
- [ ] **Step 3: Implement** — The Users email/login maps are already session-level (keep). Batch the per-slug reads (`SELECT ID WHERE LOWER(slug) IN chunk`, contributors `WHERE tutorial_ID IN ids`) into Maps. Keep the raw `db.run` + uppercase-quoted column style (it intentionally bypasses managed `modifiedBy`, comment `:1229-1230`). Preserve every `WHERE ... IS NULL` guard — convert each conditional UPDATE into a grouped UPDATE over only the ids that still satisfy the IS-NULL predicate (compute the eligible set from the batched read).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `perf(publish): batch linkTutorialAuthorship reads (#2802)`.

---

## Finding 3 — Micro-wins (Tasks 10–11)

### Task 10: Fold the duplicate `/content/hashes` GET

**Files:**
- Modify: `scripts/publish-content.ts:1322-1354`, `scripts/lib/publish-client.ts` (`fetchRemoteHashes` `:182-194`, `fetchRemotePipelineToken` `:207-215`)
- Test: `test/unit/publish-client-hashes-token.test.js` (new)

**Interfaces:**
- Produces: `fetchRemoteHashes` returns `{ hashes, pipelineToken }` (token read from the SAME response's `X-Pipeline-Token` header); the separate `fetchRemotePipelineToken` GET is removed from the delta path.

- [ ] **Step 1: Failing test** — mock a single `fetch` returning hashes JSON + `X-Pipeline-Token` header; assert one call yields both and the second GET is gone.
- [ ] **Step 2:** Run → FAIL. `npx vitest run test/unit/publish-client-hashes-token.test.js`
- [ ] **Step 3: Implement** — have `fetchRemoteHashes` read `res.headers.get('x-pipeline-token')` and return `{ hashes, pipelineToken }`; in `publish-content.ts` use that token (drop the `fetchRemotePipelineToken` call at `:1353`). Keep `fetchRemotePipelineToken` exported for any other caller, or remove if unused (grep first).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `perf(publish): fold pipeline-token into the hashes GET (#2802)`.

### Task 11: File the image-refresh outlier issue

- [ ] **Step 1:** Create a GitHub issue documenting the `Refresh tutorial images (slug-targeted)` 361s outlier (run 38816499609), referencing the spike doc. No code.

```bash
gh issue create --repo sap-tutorials/tutorials-ims \
  --title "Image-refresh step hit 361s on a full rebuild (publish spike #2802 follow-up)" \
  --body "Spike for #2802 found 'Refresh tutorial images (slug-targeted)' took 361s on run 38816499609 — co-equal with the publish step, contradicting the assumption it is always 0-2s. See docs/developers/reference/publish-performance-spike-2802.md. Investigate separately."
```

---

## Verification (final, before PR)

- [ ] `npm test` green (all unit suites, SQLite).
- [ ] Deploy branch to DEV; run an unscoped rebuild; compare the `Publish tutorial content to HANA` step time against the spike baselines (254s / 365s). Capture `PublishTimings` rows showing render-concepts phase-skip (`phaseSkipped:true`) on a shell-stable run and reduced append time on a changed run. **Do not claim the perf win until this shows it.**
- [ ] Fresh-reviewer whole-branch code review (correctness focus: the Review Focus list).
- [ ] `gh pr create` targeting DEV.

## Self-review notes

- Spec coverage: F1 Level-1 (Tasks 3,4,5) + Level-2 bodyHash (Tasks 1,2,4) + schema (1) + persistence (5); F2 all four functions (6–9); F3 fold GET (10) + image issue (11). All spec sections mapped.
- The Level-2 "skip renderConceptDetail" micro-optimization is explicitly conditional in Task 4 (only if a carried body is retrievable) — the dominant win is the Level-1 phase skip, which does not depend on it. Flagged so the implementer doesn't over-build.
- Open plan-time decision from the spec (kill-switch `CONCEPT_PHASE_DELTA`): the fail-open posture + the shell/carry-forward guards make a flag optional; recommend adding a one-line env gate in Task 4's handler if the reviewer wants a kill switch. Decide at review.
