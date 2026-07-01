# Design: Hybrid-test audit of cascade-delete behavior across all 7 KG link tables

**Issue:** [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789)
**Follow-up to:** [#787](https://github.com/sap-tutorials/tutorials-ims/issues/787) / PR [#792](https://github.com/sap-tutorials/tutorials-ims/pull/792)
**Date:** 2026-07-01

## Problem

PR #792 fixed the `TutorialConceptLinks` cascade gap and shipped a hybrid test
([test/hybrid/kg-tutorial-conceptlinks-cascade.test.js](../../../test/hybrid/kg-tutorial-conceptlinks-cascade.test.js))
that proves the cascade fires on real HANA. The other six Phase 4 parents
(`LearningJourneys`, `BlogPosts`, `DiscoveryMissions`, `Videos`, `ApiDocs`,
`Samples`) already declare their link tables as `Composition` per the #447
Task 1 review fix at [db/external-content.cds:33](../../../db/external-content.cds#L33).

The schema is correct today. But there is no test that proves the cascade
*actually fires* when a `LearningJourney` / `BlogPost` / `Video` / etc. gets
deleted. The behavior is asserted only by the schema. If a future PR silently
downgrades one of those Compositions to an Association — or if HANA's cascade
semantics surprise us — the bug would land silently and only surface when
concepts get published, i.e. the exact path #787 was discovered on.

Schema invariants without tests rot. This design closes that gap.

## Non-goals

- **No schema changes.** The six Phase 4 parents already have correct
  `Composition` declarations.
- **No fix for the `LearningJourneyPrerequisites` dangling-prereq gap.** The
  known asymmetry (cascade fires on `journey`, NOT on `prerequisite`, with a
  GC sweep expected to handle the dangling side) is preserved. The audit
  *documents* the asymmetry as an executable assertion; it does not change
  the behavior.
- **No orphan cleanup committed to the tree.** If the pre-merge sanity probe
  turns up orphan rows on any composition-side table, they are cleaned up via
  a one-shot `scripts/_*.cjs` deleted after the run — same pattern as #792's
  post-merge cleanup step.
- **No unit tests.** Unit-mode (in-memory SQLite) semantics for CDS
  Compositions are documented to differ from HANA's. Unit coverage of a
  cascade audit gives false confidence. All 11 assertions run under
  `npm run test:hybrid` against real HANA.

## Architecture

### File layout — one canonical audit file

**Added:** [test/hybrid/kg-cascade-delete.test.js](../../../test/hybrid/kg-cascade-delete.test.js)

Seven top-level `describe` blocks, one per parent entity, containing eleven
`it` blocks total. Each block owns its own HANA guard + fixture cleanup,
following the pattern established by
[test/hybrid/kg-tutorial-conceptlinks-cascade.test.js](../../../test/hybrid/kg-tutorial-conceptlinks-cascade.test.js).

**Deleted:** `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`

The Tutorials describe block from #792 is moved verbatim into the new file
(fixture IDs renumbered from the `787NNNNNNNNN` range to the `789NNNNNNNNN`
range for one-file audit continuity). Test count is unchanged for the
Tutorials case — one `it` block relocated, not rewritten.

**Not committed** (runbook-only, temp scripts per the #792 pattern):
`scripts/_kg-phase4-orphan-probe.cjs`.

Net repo change: **+1 file, −1 file, ~+165 net lines.**

### Rationale for one file vs. seven

Issue #789 proposes a single consolidated file. This design accepts that
proposal. The alternative (one file per parent, matching the current #792
file's shape) would produce seven ~35-line files. The consolidated form
makes the audit surface greppable: anyone editing an `external-content.cds`
Composition has one obvious test file to update. The cost is churning a
file that landed 1 day before this PR — mild, one-author, easy to review.

## Test matrix

Eleven `it` blocks across seven `describe` blocks. Each assertion follows
the same three-step shape:

1. INSERT parent + concept + link (or parent + services row for the two
   `*Services` tables).
2. DELETE parent.
3. Assert the link row is gone AND (where applicable) the concept survives.

| # | Parent | Link table | Predicate | Assertion type |
|---|---|---|---|---|
| 1 | `Tutorials` | `TutorialConceptLinks` | `teaches` | primary cascade (moved from #792) |
| 2 | `LearningJourneys` | `LearningJourneyConceptLinks` | `covers` | primary cascade |
| 3 | `LearningJourneys` | `LearningJourneyPrerequisites` (journey side) | — | secondary cascade — insert A + B + prereq(A→B); delete A; assert prereq row gone, B survives |
| 4 | `LearningJourneys` | `LearningJourneyPrerequisites` (prerequisite side) | — | **negative** — insert A + B + prereq(A→B); delete B; assert prereq row **survives** AND A survives (documents non-cascade); comment links to GC sweep |
| 5 | `BlogPosts` | `BlogPostConceptLinks` | `discusses` | primary cascade |
| 6 | `DiscoveryMissions` | `DiscoveryMissionConceptLinks` | `teaches` | primary cascade |
| 7 | `DiscoveryMissions` | `DiscoveryMissionServices` | — | secondary cascade (free-form service name, no concept side) |
| 8 | `Videos` | `VideoConceptLinks` | `teaches` | primary cascade |
| 9 | `Videos` | `VideoServices` | — | secondary cascade |
| 10 | `ApiDocs` | `ApiDocConceptLinks` | `officialReferenceFor` | primary cascade |
| 11 | `Samples` | `SampleConceptLinks` | `embodies` | primary cascade |

### Row 4 is the load-bearing test in this audit

Rows 1–3 and 5–11 all confirm "cascade fires as declared" — one bit of
confirmation each. Row 4 pins "cascade DELIBERATELY doesn't fire on this
side because it would break graph semantics" — which is the kind of
invariant that gets reverted 6 months later when nobody remembers why.
The assertion `expect(prereqRow).toBeDefined()` flips loudly if a future
well-intentioned PR adds a Composition on the `prerequisite` side of
`LearningJourneyPrerequisites`. A code comment on the assertion links to
the GC sweep documented at
[db/external-content.cds:36-40](../../../db/external-content.cds#L36-L40).

### Services-table shape (rows 7 and 9)

`DiscoveryMissionServices` and `VideoServices` carry free-form BTP service
names, not concept associations. Their cascade test is one parent + one
services row: delete the parent, assert the services row is gone. No
survivor assertion — there is nothing else to survive.

## Fixture conventions

Six conventions carry over from #792; one is new for this file.

### 1. HANA-only guard (per describe block)

Each `beforeAll` asserts
`db.options?.kind === 'hana' || db.constructor?.name === 'HANAService'`
and throws otherwise. Copied verbatim from #792. Unit runs (`npm test`)
never touch this file — the guard hard-throws before any INSERT.

### 2. Fixture ID convention

UUIDs of the shape `00000000-0000-0000-0000-789NNNNNNNNN`, where
`NNNNNNNNN` encodes describe-block + role:

- Tutorials block: `789000000001`–`789000000003` (parent, concept, link)
- LearningJourneys block: `789000000010`–`789000000019` (two parents A/B,
  one concept, two link rows for primary + secondary + negative)
- BlogPosts: `789000000020`–`789000000022`
- DiscoveryMissions: `789000000030`–`789000000032`
- Videos: `789000000040`–`789000000042`
- ApiDocs: `789000000050`–`789000000052`
- Samples: `789000000060`–`789000000062`

Every fixture row has a stable, greppable ID; ranges leave headroom for
future growth without renumbering. `SELECT * WHERE ID LIKE '%789%'` on
DEV surfaces any test-artefact leak immediately.

Only the LearningJourneys block currently allocates a 10-wide range because
it needs parent A + parent B (rows 3 and 4 require two parents). The three
other dual-composition blocks (`DiscoveryMissions`, `Videos`) get away with
a 3-wide range because their secondary tables — `DiscoveryMissionServices`
and `VideoServices` — need only one parent each. If a future assertion
requires two parents in one of the 3-wide ranges, expand the range at that
time; the `789NNN` namespace has ample room.

### 3. `__test__-789-*` slug prefix

Matches the `test/hybrid/_guard.js` write-safety convention.

### 4. `afterAll` is idempotent and defense-in-depth

Each block's `afterAll` unconditionally DELETEs each fixture ID. The test
itself deletes most of them via the cascade under test, but the `afterAll`
guarantees cleanup even if an assertion throws mid-test. For the two-parent
LearningJourneys block, both A and B parents are cleaned up (only one is
deleted during the primary + negative tests).

### 5. `ALLOW_HYBRID_WRITES` gate

`test/hybrid/_guard.js` already refuses writes without it. No local
exception is needed; this file inherits the project-wide guard.

### 6. HANA LOB-locator gotcha

`ApiDocs.description` and `Samples.description` are `LargeString` (NCLOB) —
never SELECT them alongside scalar metadata (documented at
[db/external-content.cds:276-283](../../../db/external-content.cds#L276-L283)).
The tests SELECT only `ID` from these tables to check row existence, so
the gotcha is dodged by omission. A comment near the ApiDocs and Samples
fixtures names the rule so a future assertion doesn't reach for
`description`.

### 7. New: single canonical file, per-block isolation

Each describe block owns its fixture UUIDs exclusively — no cross-block
sharing. If an earlier block's `afterAll` fails to run, a later block's
cascade test still passes because their UUIDs don't collide. Trade-off:
~30 lines of duplication vs. zero coupling between describe blocks. A
fair trade for a file whose whole purpose is pinning down invariants
that other people might edit.

## Pre-test sanity probe

Acceptance criterion #3 in the issue:

> `SELECT COUNT(*) FROM <link_table> WHERE <parent>_ID NOT IN (SELECT ID FROM <parent>)`
> returns 0 for all 6 Phase 4 link tables on DEV (sanity probe before tests land).

### Script

One-shot script `scripts/_kg-phase4-orphan-probe.cjs`. Leading `_` per the
convention #792 established for temp scripts. Invoked via
`npx cds bind --exec -- node scripts/_kg-phase4-orphan-probe.cjs`.

Reads ten counts (one per composition-side FK across the Phase 4 link
tables plus the two `LearningJourneyPrerequisites` sides) and prints them.
**Not committed** — same pattern as #792's `_kg-orphan-cleanup.cjs`. Lives
in the PR description as a runbook step, not in the tree.

**Exit code contract** — the script exits `1` if any of the nine
composition-side counts is > 0 (blocks a copy-paste PR checklist workflow
without manual output inspection). Exits `0` otherwise. The
`LearningJourneyPrerequisites.prerequisite_ID` count is printed but never
affects the exit code (informational only per the decision matrix below).

### Probed tables

Ten counts total:

- `LearningJourneyConceptLinks.journey_ID` → `LearningJourneys.ID`
- `LearningJourneyPrerequisites.journey_ID` → `LearningJourneys.ID` (composition side)
- `LearningJourneyPrerequisites.prerequisite_ID` → `LearningJourneys.ID` (**non-cascade side — dangling rows here are the known GC-sweep concern; report the value but don't fail on it**)
- `BlogPostConceptLinks.post_ID` → `BlogPosts.ID`
- `DiscoveryMissionConceptLinks.mission_ID` → `DiscoveryMissions.ID`
- `DiscoveryMissionServices.mission_ID` → `DiscoveryMissions.ID`
- `VideoConceptLinks.video_ID` → `Videos.ID`
- `VideoServices.video_ID` → `Videos.ID`
- `ApiDocConceptLinks.apiDoc_ID` → `ApiDocs.ID`
- `SampleConceptLinks.sample_ID` → `Samples.ID`

### Decision matrix

1. **All 10 counts = 0** → probe passes, PR merges, tests land, done.
2. **Composition-side counts > 0** (any of the nine non-`prerequisite`
   counts) → real bug of the same shape as #787. Author a one-shot
   cleanup script, add to PR runbook (mirroring #792 step 3), delete the
   orphans, then merge tests. The cascade test would fail on DEV if
   orphans persist because a leaked prior-run fixture would collide with
   a new run's assertion baseline.
3. **`prerequisite`-side count > 0** → expected-ish (the dangling-prereq
   sweep is a known GC concern). Report the value in the PR description.
   Do NOT block merge on it. If the number is surprisingly large (say
   >100), open a separate issue about the GC job's cadence — do not
   scope-creep into this PR.

### Out of scope for the probe

Checking the seven parent tables themselves for orphan concept FKs,
`ConceptLinks` predicate distribution, or `contentHash` drift. Cascade
orphans only.

## Error handling & diagnostics

No mocks, no stubs. Real HANA, real cascade. Only runs under
`npm run test:hybrid` after `cf login` + `cds bind`.

Each assertion uses plain-English `expect().toBeDefined()` /
`.toBeUndefined()`; no custom matchers. A failing cascade shows up as
"orphan row should be undefined; got: {ID: ..., predicate: '...'}" —
enough to point at the failing table without extra logging.

## Verification

### Pre-merge, in order

1. `node --check test/hybrid/kg-cascade-delete.test.js` — syntax gate.
2. `cf login` →
   `npx cds bind --exec -- node scripts/_kg-phase4-orphan-probe.cjs`
   on DEV.
   - Composition-side counts must all be 0 (9 of the 10 counts). Non-zero
     on any of them → author cleanup, run it, re-probe until 0, add to
     PR runbook, then proceed.
   - `LearningJourneyPrerequisites.prerequisite_ID` count reported for
     informational purposes; not a merge gate.
3. `ALLOW_HYBRID_WRITES=true npx cds bind --exec --
   npx vitest run test/hybrid/kg-cascade-delete.test.js` — all 11
   assertions pass on DEV.
4. Full `npm run test:hybrid` suite still green (regression check against
   sibling hybrid tests).

### Success criteria — three literal green lights

1. `SELECT COUNT(*) FROM <link_table> WHERE <parent>_ID NOT IN
   (SELECT ID FROM <parent>)` returns 0 for all 9 composition-side link
   tables on DEV.
2. All 11 hybrid assertions pass on DEV.
3. Sibling hybrid tests remain green.

## Post-merge runbook

1. **No deploy needed.** Test-only change. Approuter/srv unchanged.
2. **CI picks up the new file automatically.** The next PR landing into
   DEV runs `npm run test:hybrid` including this file — no workflow edit
   required.
3. **Temp scripts deleted.** `scripts/_kg-phase4-orphan-probe.cjs` is
   removed from the workstation after Verification step 2. Not committed.
   Not left in the tree.

## Why this matters even though nothing is currently broken

Schema invariants without tests rot. Today's `Composition` on
`LearningJourneys.links` is correct; tomorrow's PR might "simplify" it to
an `Association` without realizing the implication. The negative test
(row 4) additionally protects the deliberate asymmetry on
`LearningJourneyPrerequisites.prerequisite` — the kind of decision that
looks wrong to a future reviewer with no context and gets "fixed" by an
edit that quietly changes graph semantics.

Tests are the only line of defense.
