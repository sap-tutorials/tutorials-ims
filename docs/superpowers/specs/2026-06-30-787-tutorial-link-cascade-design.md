# Tutorial-link cascade fix (#787) — Design Spec

- **Status:** Draft for review
- **Tracking issue:** [#787](https://github.com/sap-tutorials/tutorials-ims/issues/787)
- **Follow-up issue:** [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789) (audit-test the other 6 KG link tables)
- **Date:** 2026-06-30
- **Author:** Tom Jung (with Claude)
- **Related:**
  - [Phase 3 spec — Knowledge Graph](./2026-06-27-446-knowledge-graph-phase3-design.md)
  - [Phase 4 architecture spec](./2026-06-28-447-knowledge-graph-phase4-architecture.md)
  - [#751 KG overview page (yesterday)](./2026-06-29-751-kg-overview-page-design.md) — surfaced this bug

## Summary

Fix `/build/concepts` crashing when concepts are published whose `TutorialConceptLinks` reference deleted Tutorials. Two structural changes ship as one PR; one operational cleanup runs after deploy.

1. **Schema fix** — add `Tutorials.conceptLinks : Composition of many TutorialConceptLinks on conceptLinks.tutorial = $self;` in `db/schema.cds`. Future Tutorial DELETEs cascade to their KG link rows. Mirrors the Phase 4 pattern already used by LearningJourneys / BlogPosts / etc.
2. **Defensive guard** — one-line null-filter at [srv/lib/published-concepts-query.js:64](../../../srv/lib/published-concepts-query.js#L64): `teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null)` before the `.toLowerCase()` call. Silent skip, no logging.
3. **One-shot cleanup** — `cds bind --exec`-style SQL against DEV after deploy to remove the 33 existing orphan rows. Temp script NOT committed; same pattern used for yesterday's backfill/rollback.

## Goals

1. **Unblock concept publication.** Yesterday's backfill exposed a latent crash in `/build/concepts` once any published concept had an orphan tutorial-link. Goal: re-publish concepts (top-10 smoke pass to validate) without crashing the read path or the Hugo build pipeline.
2. **Close the orphan-row source.** A schema-level cascade declaration makes new orphan rows impossible. The defensive guard is belt-and-suspenders for the one known crash site.
3. **Keep the PR tight.** One bug, one schema entity, one read path. The "audit pass on all 7 KG link tables" referenced in #787's issue body is deferred to [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789) because the Phase 4 tables already have correct schemas — they need test coverage proving the cascade fires, but no schema changes.

## Non-Goals

- **Schema changes to the 6 Phase 4 link tables** (LearningJourney, BlogPost, Discovery, Video, ApiDoc, Sample). They already declare `Composition` on the parent side per the [`#447 Task 1 review fix`](../../../db/external-content.cds#L33) comment. Their behavior is correct; only their test coverage is incomplete. See [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789).
- **Defensive guards on the other 5 read paths** that join link tables (kg-projection.js, kg-merge-on-write.js, kg-merge-pair.js, consolidate-concepts-job.js, extract-concepts-job.js, knowledge-graph-service.js). Audit confirmed: none of them read joined slugs/titles — they read `tutorial_ID` / `concept_ID` only. Adding guards there would be sympathy code for a state that cannot crash them.
- **A committed `scripts/` cleanup script.** Yesterday's pattern (backfill / rollback / count) used temp scripts run via `cds bind --exec` and deleted after the run. The orphan cleanup follows the same convention — the schema fix prevents new orphans from arising, so a one-time data-fix doesn't deserve repo surface.
- **`@cap-js/audit-logging` / `@cap-js/change-tracking` rewiring for cascade tracking.** Out of scope; these systems already operate independently of the Composition vs. Association declaration.
- **The 33 orphan rows on PROD.** PROD is not in scope today (the bug only surfaces with published concepts, and PROD has zero). When PROD cuts over later, the cleanup script can run against it as a one-off; the schema fix protects against new orphans regardless.

## Approach

### Schema change (db/schema.cds)

Add one Composition declaration inside the existing `Tutorials` entity:

```cds
@assert.unique.slug: [slug]
entity Tutorials : TaskBase {
  slug                      : String(255) @mandatory;
  // ... existing fields unchanged ...
  author                    : Association to Users;
  // [#787] Cascade-delete TCL rows on Tutorial DELETE. Mirrors the Phase 4
  // pattern in db/external-content.cds (LearningJourneys.links, etc.).
  // Without this, deleted Tutorials leave orphan link rows that crash
  // /build/concepts and other KG read handlers (see #787 root cause).
  conceptLinks              : Composition of many com.sap.developers.ims.TutorialConceptLinks
                              on conceptLinks.tutorial = $self;
}
```

**Why `db/schema.cds` and not `db/knowledge-graph.cds`:**

Phase 4 puts Composition declarations on the parent entity, in the parent's own file ([db/external-content.cds:41](../../../db/external-content.cds#L41), [:101](../../../db/external-content.cds#L101), etc.). Mirroring that places `conceptLinks` in `Tutorials`. The fully-qualified type reference (`com.sap.developers.ims.TutorialConceptLinks`) resolves at compile time across files within the same namespace.

**Migration risk: zero.** `Composition` is a CDS-level declaration that emits cascade rules in the CAP runtime DELETE handler. It does NOT change the SQL table structure or HDI artifacts. No table rebuild; no data touched. `cds build --production` will regenerate `gen/db/last-dev/csn.json` and `gen/db/src/...`; those changes need to be committed per the project's `cds_build_production_not_cds_compile_for_last_dev` convention.

### Defensive guard (srv/lib/published-concepts-query.js)

Current code at line 64:

```js
const teachesByConcept = groupBy(teachesRows, 'concept_ID', r => ({
  slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title
}));
```

Fix: one-line `.filter()` before `groupBy`, plus an explanatory comment:

```js
const teachesByConcept = groupBy(
  // Defensive: drop orphan rows where the joined Tutorial side is null.
  // The schema cascade (#787) makes this impossible going forward; the
  // filter is belt-and-suspenders for any future orphan-creating path
  // (manual SQL, migrations, schema regressions — see #789).
  teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null),
  'concept_ID',
  r => ({ slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title })
);
```

**Why `!= null` instead of `!== null`:** CDS join result columns can come back as either `null` or `undefined` depending on driver. The `!=` form catches both; `!==` would miss `undefined` and crash on the same `.toLowerCase()` call.

**Why filter both `tutorial_slug` AND `tutorial_title`:** if `tutorial_slug` is null the row is useless. `tutorial_title` is read into the payload's `title` field; a null title would render as JS `null` in the JSON, cosmetically wrong. Filtering both ensures every emitted row has a usable shape.

**Silent skip, no logging:** the schema cascade prevents the condition; logging would be noise. If the guard ever fires in practice, that's a separate bug worth investigating — but the path of investigation starts from the missing data in the payload, not from a log line.

### Read-path audit (no code changes)

Files that touch `TutorialConceptLinks` per `grep -rln "TutorialConceptLinks" srv/`:

| File | Reads joined slug/title? | Crashes on orphan? |
|---|---|---|
| `srv/lib/published-concepts-query.js` | **Yes** (`.tutorial.slug as tutorial_slug`) | **Yes** — this is the bug |
| `srv/lib/kg-projection.js` | No (reads `tutorial_ID` only) | No |
| `srv/lib/kg-merge-on-write.js` | No (write-only) | No |
| `srv/lib/kg-merge-pair.js` | No (write-only) | No |
| `srv/jobs/consolidate-concepts-job.js` | No (write-only) | No |
| `srv/jobs/extract-concepts-job.js` | No (write-only) | No |
| `srv/knowledge-graph-service.js` | No (reads `tutorial_ID + concept_ID`) | No |

Only `published-concepts-query.js` joins to `tutorial.slug`. It is the one site where the orphan can crash the read. No additional defensive guards needed.

### Cleanup procedure (post-deploy, DEV only)

After the schema fix ships, the existing 33 orphan rows still exist (cascade only fires on **future** DELETEs). Cleanup runs via the same `cds bind --exec` pattern used yesterday for the concept backfill:

```js
// scripts/_kg-orphan-cleanup.cjs (temp, deleted after run)
const cds = require('@sap/cds');
(async () => {
  await cds.connect.to('db');
  const db = await cds.connect.to('db');

  const before = await db.run(
    `SELECT COUNT(*) as n FROM com_sap_developers_ims_TutorialConceptLinks l
     LEFT JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE t.ID IS NULL`
  );
  console.log('Orphan TCL rows before:', before[0].N ?? before[0].n);

  const result = await db.run(
    `DELETE FROM com_sap_developers_ims_TutorialConceptLinks
      WHERE tutorial_ID NOT IN (SELECT ID FROM com_sap_developers_ims_Tutorials)`
  );
  console.log('Rows deleted:', result);

  const after = await db.run(
    `SELECT COUNT(*) as n FROM com_sap_developers_ims_TutorialConceptLinks l
     LEFT JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE t.ID IS NULL`
  );
  console.log('Orphan TCL rows after:', after[0].N ?? after[0].n);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
```

Run: `npx cds bind --exec -- node scripts/_kg-orphan-cleanup.cjs`. Then `rm scripts/_kg-orphan-cleanup.cjs`. Not committed.

**Order matters:** the cleanup MUST run AFTER the schema fix is deployed. If we cleaned up first and deployed later, any Tutorial DELETEs in the gap would create new orphans.

### Smoke-publish (post-cleanup, DEV)

Validate the read path holds with a tiny published-concept set before larger backfills in future sessions:

```js
// scripts/_kg-publish-top10.cjs (temp, deleted after run)
// Publishes the top-10 concepts by extractionCount with a dated marker.
```

After publishing, smoke-verify:
- `curl /build/concepts` → 200 with 10 entries
- `curl /build/kg-stats` → `{"concepts": 10, ...}`

If both green: subsequent batches in later sessions are safe. The 10-row floor is intentionally small to fail-fast if anything regressed.

## Testing strategy

### Unit (`npm test`, in-memory SQLite)

One new test in `test/unit/build-concepts.test.js`:

- **`skips link rows whose tutorial side is null (orphan-row defense)`** — INSERTs a TCL row with `tutorial_ID` pointing to a non-existent UUID (bypassing the Composition cascade by inserting after Tutorial setup). Asserts `/build/concepts` returns 200, the orphan link is absent from the response, and valid links are present.

The test exercises the **runtime guard**, not the schema cascade. That keeps it valuable independently — if a future PR weakens the Composition, the guard still proves the read path stays up.

### Hybrid (`npm run test:hybrid`, real HANA via `cds bind --exec`)

One new test file at `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`:

- **`deletes TutorialConceptLinks when their parent Tutorial is deleted`** — INSERTs `__test__`-prefixed Tutorial + Concept + Link, DELETEs the Tutorial, asserts the Link is gone (cascade fired) and the Concept survives (Concepts is composed by Concept, not by the parent Tutorial).

Follows the `__test__` write-safety prefix convention enforced by [test/hybrid/_guard.js](../../../test/hybrid/_guard.js). Cleanup in `afterAll`.

The hybrid test is essential here because the Composition cascade is a CAP-runtime-emitted behavior; SQLite and HANA implement it slightly differently. Asserting it in the same runtime that production uses is the only honest proof.

### Smoke (`npm run test:smoke`, HTTP against deployed)

**No new smoke tests.** The existing `test/smoke/kg-stats.smoke.test.js` and the manual `curl /build/concepts` verification in the deploy sequence cover the post-deploy state. Adding a smoke test specifically for "orphan-row scenario" would require setup/teardown of test rows in production — bad pattern.

### Manual verification (post-deploy)

Per the deploy sequence:
- `curl /build/concepts` returns 200 with empty array (post-cleanup, pre-smoke-publish)
- `cds bind --exec` publishes top-10 concepts → `curl /build/kg-stats` reflects `concepts: 10` and `curl /build/concepts` returns 200 with 10 entries

## Risks & rollback

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Composition declaration changes generated SQL unexpectedly | Low | High | `Composition` is CDS-level; emits cascade rules in CAP runtime DELETE handler, NOT in DDL. Verified by inspecting `gen/db/src/` output: no schema-level cascade clause added. |
| `cds build` warns/errors on cross-file type reference | Low | Med | Phase 4 already uses the same fully-qualified-name pattern across `db/schema.cds` and `db/external-content.cds`. Confirmed working in production. |
| Defensive guard hides a real bug | Low | Low | The guard silently skips rows the schema cascade prevents. If a future bug creates orphans, `/build/concepts` returns slightly-wrong-but-not-crashing JSON; anomalies surface in published-concept counts visible to admins. |
| Cleanup deletes more rows than expected | Low | High | Pre-flight count probe (step 3 of deploy sequence) reports orphan count before deletion; expected ~33 on DEV. If the number is wildly higher we abort. |
| The 10-row smoke publish exposes a different latent bug | Low | Med | Top-10 is small enough to inspect manually. If `/build/concepts` returns 200 but payload looks wrong, revert via `UPDATE Concepts SET publishedAt = NULL WHERE publishedBy LIKE 'smoke-787-%'`. |

### Rollback plan

The PR can be reverted in three steps:

1. **Revert the merge commit on `main`** → `git revert <merge-sha>` + redeploy. Schema returns to pre-#787 state (no Composition). Existing TCL rows are unaffected.
2. **Reverse the smoke publish** → `UPDATE Concepts SET publishedAt = NULL, publishedBy = NULL WHERE publishedBy LIKE 'smoke-787-%'`. Single SQL, restores zero published concepts.
3. **Orphan cleanup is NOT reversible** — deleted rows are gone by design. Restoring them would re-introduce the very orphans we just cleaned. Don't roll them back.

No data loss in scenarios 1 + 2. Scenario 3 is intentional.

## Build sequence

Single PR.

### PR: `fix(#787): cascade-delete TutorialConceptLinks on Tutorial DELETE + orphan-row guard`

**Files changed (5):**

| File | Change |
|---|---|
| [db/schema.cds](../../../db/schema.cds) | +4 lines (Composition + comment) on `Tutorials` |
| [srv/lib/published-concepts-query.js](../../../srv/lib/published-concepts-query.js) | One-line `.filter()` + 4-line comment |
| `test/unit/build-concepts.test.js` (extend existing) | +1 test case (~25 lines) |
| `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` (new) | ~40 lines |
| `gen/db/last-dev/csn.json` + `gen/db/src/...` (regenerated) | Auto-generated by `cds build --production` per [feedback_cds_build_production_not_cds_compile_for_last_dev](../../../scripts/) |

**Out-of-PR (operator steps after merge + deploy):**

- Run cleanup script via `cds bind --exec` → deletes the 33 orphans
- Run smoke-publish-top-10 via `cds bind --exec` → confirms read path holds
- Both temp scripts deleted (not committed)

### Effort estimate

- Schema change + cds build: 15 min
- Defensive guard + unit test: 30 min
- Hybrid test: 30 min
- PR open + review wait: session time
- Post-merge deploy + cleanup + smoke verify: ~25 min

**Total active engineering time: ~75 min.** Plus deploy wall-clock.

## Decisions locked during brainstorming

For future reference, the 4 conceptual + 3 design-section decisions:

1. **Scope: option A** — fix `TutorialConceptLinks` only. Phase 4 tables already have correct schemas; their test audit is deferred to #789.
2. **Schema fix: option A** — Composition declaration on `Tutorials`, in `db/schema.cds`, mirroring Phase 4 pattern.
3. **Defensive guard: KEEP, silent skip** — one-line `.filter()` at the one crash site. No logging.
4. **Cleanup: option A** — one-shot via `cds bind --exec`, temp script not committed. Same pattern as yesterday's backfill/rollback.
5. **Test surfaces** — 1 unit (orphan-row defense) + 1 hybrid (cascade verification) + no new smoke. Manual post-deploy verification covers the smoke surface.
6. **PR shape** — single PR; no value in splitting schema fix vs guard vs tests.
7. **Operational sequence** — schema-fix-deploy → cleanup → smoke-publish-top-10 → larger batches in future sessions.
