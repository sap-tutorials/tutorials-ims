# 172 PR 4 — Joule narration tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make branch reasoning askable through Joule chat — a new `getBranchRecommendation` chat tool lets the LLM answer "why is HANA recommended?" or "what's the difference between branches?" by calling PR 1's engine directly. The tutorial step-help FAB seeds branch-aware starter prompts when the user is reading a tutorial with branching, so the user can ask with one click instead of typing context.

**Architecture:** New `srv/lib/branch/joule-tool.js` exports the OpenAI tool definition + a handler that composes its own engine queries (reads `BranchSpecs` from PR 3 + `Missions/CompletionPaths/CompletionPathItems` from PR 2 substrate; calls `pickBranch` and `evaluateSkip` directly; writes `BranchDecisions` rows with `source: 'jouleTool'`). `chat-orchestrator.js` registers the tool when `branchingEnabled` flag is on. `chat-context.js` appends a `BRANCHING_GUIDANCE` line when `branchContext` is in the page context. The Vue island publishes branch state via a CustomEvent bus; `u1-object-page.html` collects events into a Map; `opGetCurrentStep()` and `joule.js#readPageContext` both read from that Map. New `tutorial-step-with-branch` starter kind in `joule-starters.html` with three branch-aware prompts.

**Tech Stack:** CDS + CAP Node.js, vitest unit + hybrid, Vue 3 + UI5 web components, Hugo templates.

**Spec section refs:** §4.1 (tool), §4.2 (orchestrator integration), §4.3 (system prompt), §4.4 (state bus), §4.5 (BranchPicker.vue), §4.6 (page reader), §4.7 (starters), §4.8 (joule.js), §6 (edge cases), §7 (testing), §8 (default-off), §10 (DoD).

**Depends on:** PR 1 + PR 2 + PR 3 merged. Reuses `srv/lib/branch/{condition,engine,ranker,user-state,loaders,mission-detail,decide,slug-key}.js`, `BranchSpecs` entity, `BranchDecisions` entity, `ChatSettings.branchingEnabled` flag, `BranchPicker.vue` island.

---

## File Structure

**Create (4 files):**
- `srv/lib/branch/joule-tool.js` — pure tool handler module + tool definition
- `test/branch-joule-tool.test.js` — ~7 unit tests against in-memory CDS test serve
- `test/hybrid/branch-joule-tool.test.js` — 1 hybrid HANA round-trip test
- `hugo-apps/src/tutorial-branches/branch-state-bus.ts` — tiny CustomEvent publish/subscribe module

**Modify (~9 files):**
- `srv/lib/chat-orchestrator.js` — register tool, dispatch handler, export
- `srv/lib/chat-context.js` — append `BRANCHING_GUIDANCE` when relevant
- `hugo-apps/src/tutorial-branches/BranchPicker.vue` — call `publishBranchState` on state change
- `hugo/layouts/tutorials/u1-object-page.html` — replace `opGetCurrentStep` with bus-aware version
- `hugo/layouts/_default/baseof.html` — add `data-altgroups-count` for mission/group pages
- `hugo/layouts/partials/joule-starters.html` — add `tutorial-step-with-branch` kind
- `hugo/static/js/joule.js` — switch starter kind, extend substituteStarter, extend readPageContext
- `.deploy/mta.yaml` — register `joule-tool.js` in srv-qa cp list
- `docs/developers/operations/testing-endpoints.md` — document new chat tool
- (Optional: chat-settings admin help text in admin app — search for existing help-text pattern in Task 11)

**Test files:**
- `test/branch-joule-tool.test.js` (new)
- `test/hybrid/branch-joule-tool.test.js` (new)
- Append to existing `test/chat-orchestrator-tools.test.js` if it exists, else create — verify tool registration with flag on/off
- Append to existing joule.js tests if any, else inline checks via the hybrid suite

**No new npm dependencies.**

---

## Task 0: Branch sanity & worktree confirmation

**Files:** none (verification only)

- [ ] **Step 1: Confirm working branch + clean state**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
```
Expected: `feat/172-pr4-joule-narration`

```bash
git status
```
Expected: clean (or only the spec doc already committed in `2026-06-11-172-branching-pr4-joule-narration-design.md`).

If on `main`, abort and recreate the branch from `main`.

- [ ] **Step 2: Verify spec exists**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md
```
Expected: file exists.

- [ ] **Step 3: Verify PR 1+2+3 substrate is in place**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/srv/lib/branch/
```
Expected: `condition.js`, `decide.js`, `engine.js`, `loaders.js`, `mission-detail.js`, `ranker.js`, `slug-key.js`, `user-state.js`. If any missing, STOP — earlier PRs aren't merged into main.

```bash
grep -n "BranchSpecs" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/db/schema.cds | head -3
```
Expected: at least one hit.

```bash
grep -n "GET_RELEVANT_STEPS_TOOL\|name: 'getRelevantSteps'" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/srv/lib/chat-orchestrator.js | head -3
```
Expected: hits at lines around 129–142 (existing tool definition pattern to mirror).

---

## Task 1: Tool definition + handler scaffold (no logic yet)

**Files:**
- Create: `srv/lib/branch/joule-tool.js`
- Test: `test/branch-joule-tool.test.js`

This task scaffolds the module with the OpenAI tool definition, the exported handler function, and the param-validation logic. Subsequent tasks fill in tutorial scope, mission scope, and combined scope TDD-style.

- [ ] **Step 1: Write the failing tests for param validation**

Create `test/branch-joule-tool.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { GET_BRANCH_RECOMMENDATION_TOOL, getBranchRecommendationHandler } from '../srv/lib/branch/joule-tool.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET_BRANCH_RECOMMENDATION_TOOL', () => {
  it('exports an OpenAI-shaped tool definition', () => {
    expect(GET_BRANCH_RECOMMENDATION_TOOL.type).toBe('function');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.name).toBe('getBranchRecommendation');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('missionSlug');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('tutorialSlug');
    expect(GET_BRANCH_RECOMMENDATION_TOOL.function.parameters.properties).toHaveProperty('branchPointId');
  });
});

describe('getBranchRecommendationHandler — param validation', () => {
  it('rejects when no params given', async () => {
    const result = await getBranchRecommendationHandler({ args: {}, user: null });
    expect(result.error).toMatch(/requires_at_least_one_of/);
  });

  it('rejects branchPointId without tutorialSlug', async () => {
    const result = await getBranchRecommendationHandler({
      args: { branchPointId: '1-deployment' }, user: null
    });
    expect(result.error).toMatch(/branchPointId requires tutorialSlug/);
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the tool module shell**

Create `srv/lib/branch/joule-tool.js`:

```javascript
// srv/lib/branch/joule-tool.js
//
// Issue #172 PR 4 — Joule chat tool that returns branch recommendations
// for a tutorial or mission. Composes its own engine queries directly
// (does NOT go through HTTP-shaped handlers like decide.js / mission-detail.js).
// Writes one BranchDecisions row per recommendation with source='jouleTool'.
//
// Spec: docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md §4.1
//
// Registered in srv/lib/chat-orchestrator.js when ChatSettings.branchingEnabled.

import cds from '@sap/cds';

const LOG = cds.log('branch-joule-tool');

export const GET_BRANCH_RECOMMENDATION_TOOL = {
  type: 'function',
  function: {
    name: 'getBranchRecommendation',
    description: "When the user is on a tutorial or mission with branching, return which branch is recommended for them and why. Use this when the user asks 'which path should I take', 'what next in this mission', 'should I do the cloud or on-prem version', or similar. Do NOT use this to decide which branch is best — return the engine's existing recommendation with reason.",
    parameters: {
      type: 'object',
      properties: {
        missionSlug:   { type: 'string', description: 'When set, return alt-group recommendations for the mission.' },
        tutorialSlug:  { type: 'string', description: 'When set, return branchPoints + skipPoints for the tutorial.' },
        branchPointId: { type: 'string', description: 'Optional — narrow tutorial result to one branch point. Requires tutorialSlug.' },
      },
    },
  },
};

export async function getBranchRecommendationHandler({ args, user }) {
  // Lowercase slugs at handler entry per CLAUDE.md tutorial-slug rule.
  const missionSlug   = args?.missionSlug   ? String(args.missionSlug).toLowerCase()   : null;
  const tutorialSlug  = args?.tutorialSlug  ? String(args.tutorialSlug).toLowerCase()  : null;
  const branchPointId = args?.branchPointId ? String(args.branchPointId)               : null;

  if (!missionSlug && !tutorialSlug && !branchPointId) {
    return { error: 'requires_at_least_one_of: missionSlug, tutorialSlug, branchPointId' };
  }
  if (branchPointId && !tutorialSlug) {
    return { error: 'branchPointId requires tutorialSlug' };
  }

  // Subsequent tasks fill in tutorial + mission resolution.
  return { branchPoints: [], altGroups: [], skipPoints: [], note: 'not_yet_implemented' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -8
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
# Must be: feat/172-pr4-joule-narration
git add srv/lib/branch/joule-tool.js test/branch-joule-tool.test.js
git commit -m "feat(172): scaffold getBranchRecommendation tool + param validation"
```

---

## Task 2: Tutorial-scope resolution

**Files:**
- Modify: `srv/lib/branch/joule-tool.js`
- Modify: `test/branch-joule-tool.test.js`

Implement the tutorial-scope path: read `BranchSpecs`, parse JSON, run `pickBranch` per branchPoint and `evaluateSkip` per skipPoint, write `BranchDecisions` rows.

- [ ] **Step 1: Append tutorial-scope tests to `test/branch-joule-tool.test.js`**

Add a new `describe` block exercising 6 cases:

1. **Anonymous tutorial query** — seed `BranchSpecs` with one row containing two branchPoints + one skipPoint. Call handler with `{ tutorialSlug }`. Assert: `branchPoints.length === 2`, each has `id/picked/reason/confidence/allBranches`; `skipPoints.length === 1` with `skip: false` (anon → no completion); `altGroups` empty.
2. **branchPointId scoping** — call with `{ tutorialSlug, branchPointId: '1-deployment' }`. Assert: `branchPoints.length === 1` and only the matching id.
3. **Unknown branchPointId** — call with `{ tutorialSlug, branchPointId: 'does-not-exist' }`. Assert: `result.error` matches `/unknown_branch_point/`.
4. **Tutorial without BranchSpecs row** — call with `{ tutorialSlug: 'no-such-tutorial' }`. Assert: empty arrays + `note: 'tutorial_has_no_branches'`.
5. **Slug case-normalization** — call with uppercased slug. Assert: same result as lowercase.
6. **Telemetry write** — DELETE existing `BranchDecisions` rows with `tutorialSlug = TUT_SLUG`, call handler, then SELECT BranchDecisions where `tutorialSlug = TUT_SLUG`. Assert: `length >= 2` (one per branchPoint; skip-points only on skip:true), every `source === 'jouleTool'`, every `surface === 'tutorialBranch'`.

Test fixture (seed `BranchSpecs` in `beforeAll`, cleanup in `afterAll`):

```javascript
const TUT_SLUG = '__test__-tut-pr4';

beforeAll(async () => {
  const { BranchSpecs } = cds.entities('com.sap.developers.ims');
  await INSERT.into(BranchSpecs).entries({
    slug: TUT_SLUG,
    branchPoints: JSON.stringify([{
      id: '1-deployment',
      parentStepNumber: 1,
      groupKey: 'deployment',
      branches: [
        { key: 'hana',     label: 'HANA Cloud', condition: "profile.deployment == 'cloud'", embeddingHint: 'Configure HANA' },
        { key: 'postgres', label: 'PostgreSQL', condition: null, embeddingHint: 'Configure PG' },
      ],
    }, {
      id: '3-storage',
      parentStepNumber: 3,
      groupKey: 'storage',
      branches: [
        { key: 's3',     label: 'S3', condition: null, embeddingHint: null },
        { key: 'azure',  label: 'Azure Blob', condition: null, embeddingHint: null },
      ],
    }]),
    skipPoints: JSON.stringify([
      { stepNumber: 4, skipIf: 'completed:__test__-prereq', skipLabel: 'Skip', skipReason: 'You have it' },
    ]),
  });
});

afterAll(async () => {
  const { BranchSpecs } = cds.entities('com.sap.developers.ims');
  await DELETE.from(BranchSpecs).where({ slug: TUT_SLUG });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: FAIL — placeholder return doesn't match the test contract.

- [ ] **Step 3: Implement tutorial-scope in `srv/lib/branch/joule-tool.js`**

Add helper imports near the top (after `import cds`):

```javascript
import { pickBranch, evaluateSkip } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';
```

Replace the placeholder body of `getBranchRecommendationHandler` after the param-validation block. The handler now:

1. Wraps the work in try/catch; on unexpected error returns `{ error: 'tool_failed' }` (logged via `LOG.error`).
2. Builds `loaders = makeBranchLoaders()` and `userState = await buildUserState(user, loaders)` once.
3. If `tutorialSlug` is set, calls `resolveTutorialScope(...)`. If that returns `{ error }`, propagate. Otherwise merge its `branchPoints`, `skipPoints`, optional `note` into `out`.
4. Mission scope (Task 3) lands in this block too.
5. Returns `out`.

Add a private `resolveTutorialScope({ tutorialSlug, branchPointId, user, userState, loaders })` helper that:

1. Reads `SELECT.one.from(BranchSpecs).where({ slug: tutorialSlug })`.
2. If no row → returns `{ branchPoints: [], skipPoints: [], note: 'tutorial_has_no_branches' }`.
3. JSON-parses `spec.branchPoints` and `spec.skipPoints`, defaulting to `[]` on parse error (with `LOG.warn`).
4. If `branchPointId` is set, filters `branchPoints` to that id. If filter result is empty → returns `{ error: \`unknown_branch_point: ${branchPointId}\` }`.
5. For each `bp`:
   - Builds `branchPoint = { id: bp.id, surface: 'tutorialBranch', branches: bp.branches }`.
   - Calls `pickBranch(branchPoint, userState, { tutorialSlug }, { rankBranches: (b, s, c) => rankBranches(b, s, c, loaders) })` inside try/catch (engine should be total per PR 1, but defensive: degrade to `{ picked: bp.branches[0]?.key, reason: { kind: 'default' }, confidence: 0 }` on throw, with `LOG.warn`).
   - Pushes to `outBranchPoints`: `{ id, picked, reason, confidence, allBranches: bp.branches.map(b => ({ key, label })) }`.
   - Calls `writeBranchDecision({ user, surface: 'tutorialBranch', tutorialSlug, missionSlug: null, branchPointId: bp.id, decision })`.
6. For each `sp`:
   - Calls `evaluateSkip(sp.skipIf, userState)` inside try/catch (degrade to `{ skip: false, reason: { kind: 'parse-error', ... } }` on throw with `LOG.warn`).
   - Pushes to `outSkipPoints`: `{ stepNumber, skip, reason, ...(sp.skipLabel ? { skipLabel } : {}), ...(sp.skipReason ? { skipReason } : {}) }`.
   - If `result.skip === true`, calls `writeSkipDecision({ user, tutorialSlug, stepNumber: sp.stepNumber, reason: result.reason })`.
7. Returns `{ branchPoints: outBranchPoints, skipPoints: outSkipPoints }`.

Add module-private `writeBranchDecision({ user, surface, missionSlug, tutorialSlug, branchPointId, decision })`:
- Resolves `userIdInternal` via `SELECT.one.from(Users).columns('ID').where({ uuid: user.id })` when `user?.id`; null otherwise.
- `INSERT.into(BranchDecisions).entries({ user_ID, surface, missionSlug, tutorialSlug, branchPointId, recommendedKey: decision.picked, chosenKey: null, recommendationKind: decision.reason.kind, confidence: decision.confidence, source: 'jouleTool', followedRecommendation: null })`.
- Wraps in try/catch with `LOG.warn` on failure (best-effort, mirrors `decide.js` / `mission-detail.js`).

Add module-private `writeSkipDecision({ user, tutorialSlug, stepNumber, reason })`:
- Same user lookup.
- `INSERT.into(BranchDecisions)` with `surface: 'tutorialSkip'`, `branchPointId: \`step-${stepNumber}\``, `recommendedKey: 'skip'`, `recommendationKind: reason.kind`, `confidence: 1.0`, `source: 'jouleTool'`.
- Same try/catch.

The pattern mirrors `srv/lib/branch/decide.js` lines 151–195 (writeBranchDecision + writeSkipDecision in PR 3). If unsure of any field, read `decide.js` for the exact shape.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: 9 tests pass (3 from Task 1 + 6 here).

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
# Must be: feat/172-pr4-joule-narration
git add srv/lib/branch/joule-tool.js test/branch-joule-tool.test.js
git commit -m "feat(172): joule-tool tutorial-scope resolution + telemetry"
```

---

## Task 3: Mission-scope resolution

**Files:**
- Modify: `srv/lib/branch/joule-tool.js`
- Modify: `test/branch-joule-tool.test.js`

Implement the mission-scope path: read `Missions/CompletionPaths/CompletionPathItems`, group items by `(itemOrder, altGroupKey)`, run `pickBranch` per alt-group, return `altGroups[]`. Mirror PR 2's `mission-detail.js` data-shaping logic but compose the engine call directly (no HTTP round-trip).

- [ ] **Step 1: Append mission-scope tests**

In `test/branch-joule-tool.test.js`, add a new `describe` block exercising 3 cases:

1. **Mission with one alt-group** — seed `Missions`, `CompletionPaths`, `CompletionPathItems` (two items at the same `itemOrder` with matching `altGroupKey='deployment'`). Call handler with `{ missionSlug }`. Assert: `altGroups.length === 1`, `groupKey === 'deployment'`, `picked` is one of the branch keys, `allBranches.length === 2`.
2. **Mission with no alt-groups** — seed a mission with all `altGroupKey: null` items. Assert: `altGroups: []`, `note: 'mission_has_no_alt_groups'`.
3. **Combined tutorial + mission scope** — seed both. Call with `{ tutorialSlug, missionSlug }`. Assert: both `branchPoints` and `altGroups` populated.

Use `slugifyKey` from `srv/lib/branch/slug-key.js` to derive branch keys for assertions:

```javascript
import { slugifyKey } from '../srv/lib/branch/slug-key.js';
// branch.key === slugifyKey('HANA Cloud') === 'hana-cloud'
```

Test fixture for the alt-group mission (seed in `beforeAll`, cleanup in `afterAll`):

```javascript
const MISSION_SLUG = '__test__-mission-pr4';
const MISSION_ID = 'aaaaaaaa-9400-0000-0000-000000000400';
const PATH_ID    = 'bbbbbbbb-9400-0000-0000-000000000400';
const TUT_HANA_ID = 'cccccccc-9400-0000-0000-000000000410';
const TUT_PG_ID   = 'cccccccc-9400-0000-0000-000000000420';

beforeAll(async () => {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tutorials).entries([
    { ID: TUT_HANA_ID, legacyId: 99410, slug: '__test__-pr4-hana', title: 'HANA', status: 'ACTIVE' },
    { ID: TUT_PG_ID,   legacyId: 99411, slug: '__test__-pr4-pg',   title: 'PG',   status: 'ACTIVE' },
  ]);
  await INSERT.into(Missions).entries({
    ID: MISSION_ID, legacyId: 99400, title: 'PR4 Mission', slug: MISSION_SLUG, published: true,
  });
  await INSERT.into(CompletionPaths).entries({
    ID: PATH_ID, legacyId: 99401, mission_ID: MISSION_ID, name: 'P1', slug: '__test__-pr4-p1',
  });
  await INSERT.into(CompletionPathItems).entries([
    { ID: 'dddddddd-9400-0000-0000-000000000410', legacyId: 99410, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99410, tutorial_ID: TUT_HANA_ID, itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
    { ID: 'dddddddd-9400-0000-0000-000000000420', legacyId: 99411, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99411, tutorial_ID: TUT_PG_ID,   itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
  ]);
});

afterAll(async () => {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
  await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
  await DELETE.from(Missions).where({ ID: MISSION_ID });
  await DELETE.from(Tutorials).where({ ID: { in: [TUT_HANA_ID, TUT_PG_ID] } });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: FAIL — mission scope returns empty `altGroups`.

- [ ] **Step 3: Implement `resolveMissionScope`**

Add `import { slugifyKey } from './slug-key.js';` at the top.

In `getBranchRecommendationHandler`, after the tutorial-scope block, add:

```javascript
if (missionSlug) {
  const missionResult = await resolveMissionScope({ missionSlug, user, userState, loaders });
  if (missionResult.altGroups) out.altGroups = missionResult.altGroups;
  if (missionResult.note && !out.note) out.note = missionResult.note;
}
```

Add `resolveMissionScope({ missionSlug, user, userState, loaders })` helper:

1. Read `SELECT.one.from(Missions).where({ slug: missionSlug })`. If not found → `{ altGroups: [], note: 'mission_not_found' }`.
2. Read `SELECT.from(CompletionPaths).where({ mission_ID: mission.ID })`. If empty → `{ altGroups: [], note: 'mission_has_no_alt_groups' }`.
3. Read `SELECT.from(CompletionPathItems).where({ path_ID: { in: paths.map(p => p.ID) } }).orderBy('itemOrder')`.
4. Group items by `(itemOrder, altGroupKey)` — same logic as `srv/lib/branch/mission-detail.js`'s `groupByAlt` (skip items with null altGroupKey; aggregate the rest into groups). If no alt-groups found → `{ altGroups: [], note: 'mission_has_no_alt_groups' }`.
5. For each alt-group, build `branchPoint = { id: \`${parentStepNumber}-${groupKey}\`, surface: 'missionAltGroup', branches: items.map(it => ({ key: slugifyKey(it.altGroupLabel), label: it.altGroupLabel, condition: it.altCondition ?? null, embeddingHint: null })) }`. parentStepNumber = `itemOrder` here (mission alt-groups are positioned by `itemOrder`, not by an explicit step heading).
6. Call `pickBranch(branchPoint, userState, { missionSlug }, { rankBranches })` (same pattern as tutorial scope — try/catch, default fallback on throw).
7. Push `{ id: branchPoint.id, groupKey, picked, reason, confidence, allBranches: branchPoint.branches.map(b => ({ key: b.key, label: b.label })) }` to `outAltGroups`.
8. Call `writeBranchDecision({ user, surface: 'missionAltGroup', missionSlug, tutorialSlug: null, branchPointId: branchPoint.id, decision })`.
9. Return `{ altGroups: outAltGroups }`.

The grouping logic mirrors `groupByAlt` in `srv/lib/branch/mission-detail.js` lines 130–148. Read that file before writing this helper.

- [ ] **Step 4: Run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: 12 tests pass (3 + 6 + 3).

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
# Must be: feat/172-pr4-joule-narration
git add srv/lib/branch/joule-tool.js test/branch-joule-tool.test.js
git commit -m "feat(172): joule-tool mission-scope resolution"
```

---

## Task 4: Chat orchestrator integration

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`
- Test: extend `test/chat-orchestrator-tools.test.js` (or create if missing)

Register the tool in `toolsForContext` when `branchingEnabled`. Dispatch `getBranchRecommendation` calls to the handler. Export the tool definition for orchestrator-tool tests.

- [ ] **Step 1: Inspect existing chat-orchestrator-tools test (if present)**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/test/ | grep -i chat-orch
```

If a test file like `chat-orchestrator-tools.test.js` exists, append to it. If not, create a new one with the same setup pattern as `test/branch-joule-tool.test.js`.

- [ ] **Step 2: Write failing test for tool registration**

Add a new `describe` block:

```javascript
import { toolsForContext } from '../srv/lib/chat-orchestrator.js';

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

describe('toolsForContext — getBranchRecommendation registration', () => {
  afterEach(async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it('registers getBranchRecommendation when branchingEnabled=true', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('getBranchRecommendation');
  });

  it('does NOT register getBranchRecommendation when branchingEnabled=false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).not.toContain('getBranchRecommendation');
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/chat-orchestrator-tools.test.js 2>&1 | tail -10
```
Expected: FAIL — tool not in array.

- [ ] **Step 4: Wire the tool into `srv/lib/chat-orchestrator.js`**

In `srv/lib/chat-orchestrator.js`:

1. Add import near the top (alongside other tool-related imports):

```javascript
import { GET_BRANCH_RECOMMENDATION_TOOL, getBranchRecommendationHandler } from './branch/joule-tool.js';
```

2. In `toolsForContext`, after the existing `if (settings?.codeCheckEnabled)` block (around line 192), add:

```javascript
if (settings?.branchingEnabled) {
  tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
}
```

3. Add tool dispatch alongside existing handlers. Place near `if (name === 'checkCode')` (around line 424):

```javascript
if (name === 'getBranchRecommendation') {
  return await getBranchRecommendationHandler({ args, user });
}
```

Verify by reading the file: the dispatch happens inside the loop where each tool call is matched by name. Look for the exact pattern of the surrounding `if (name === '...')` blocks and follow it. Make sure the `args` and `user` are in scope at that callsite.

4. Add `GET_BRANCH_RECOMMENDATION_TOOL` to the export list at line 598:

```javascript
export { SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GET_RELEVANT_STEPS_TOOL, GET_USER_PROGRESS_TOOL, CHECK_CODE_TOOL, GET_BRANCH_RECOMMENDATION_TOOL, toolsForContext };
```

- [ ] **Step 5: Run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/chat-orchestrator-tools.test.js test/branch-joule-tool.test.js 2>&1 | tail -10
```
Expected: 14 tests pass (12 + 2 new).

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
# Must be: feat/172-pr4-joule-narration
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-tools.test.js
git commit -m "feat(172): register getBranchRecommendation chat tool when branchingEnabled"
```

---

## Task 5: System prompt guidance

**Files:**
- Modify: `srv/lib/chat-context.js`
- Test: extend `test/chat-context.test.js` (or create if missing)

Append a `BRANCHING_GUIDANCE` line to the system prompt when the user is on a tutorial with branchContext or a mission/group with alt-groups. Mirrors how `RAG_GUIDANCE` works for the `getRelevantSteps` tool.

- [ ] **Step 1: Inspect existing chat-context tests**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/test/ | grep -i chat-context
```

If present, extend. If not, create.

- [ ] **Step 2: Write failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt — BRANCHING_GUIDANCE', () => {
  it('appends BRANCHING_GUIDANCE on tutorial pages with branchContext', () => {
    const prompt = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Configure database',
      slug: 'configure-database',
      currentStep: 3,
      branchContext: {
        branchPointId: '3-deployment',
        groupKey: 'deployment',
        currentBranch: 'hana',
        recommendedBranch: 'hana',
      },
    }, null);
    expect(prompt).toMatch(/getBranchRecommendation/);
  });

  it('does NOT append BRANCHING_GUIDANCE on tutorial pages WITHOUT branchContext', () => {
    const prompt = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Plain tutorial',
      slug: 'plain',
      currentStep: 1,
    }, null);
    expect(prompt).not.toMatch(/getBranchRecommendation/);
  });

  it('appends BRANCHING_GUIDANCE on mission pages with altGroupsCount > 0', () => {
    const prompt = buildSystemPrompt({
      kind: 'mission',
      title: 'BTP CAP onboarding',
      altGroupsCount: 1,
    }, null);
    expect(prompt).toMatch(/getBranchRecommendation/);
  });

  it('does NOT append BRANCHING_GUIDANCE on mission pages with altGroupsCount: 0 or absent', () => {
    const prompt = buildSystemPrompt({
      kind: 'mission',
      title: 'No-branches mission',
    }, null);
    expect(prompt).not.toMatch(/getBranchRecommendation/);
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/chat-context.test.js 2>&1 | tail -10
```
Expected: FAIL — guidance not appended.

- [ ] **Step 4: Implement guidance in `srv/lib/chat-context.js`**

After the existing `RAG_GUIDANCE` constant declaration (around line 36), add:

```javascript
const BRANCHING_GUIDANCE = "When the user asks about branch choices, recommendations, or 'why this branch', call `getBranchRecommendation` rather than guessing — it returns the engine's recommendation with reason. Cite the recommended branch's label (not its key).";
```

In `tutorialLayer(ctx)` (around line 51), append to the `lines` array when `ctx.branchContext` is present:

```javascript
if (ctx.branchContext) {
  lines.push(BRANCHING_GUIDANCE);
}
```

In `collectionLayer(ctx, kindLabel)` (around line 77), append when `ctx.altGroupsCount > 0`:

```javascript
if (ctx.altGroupsCount > 0) {
  lines.push(BRANCHING_GUIDANCE);
}
```

- [ ] **Step 5: Run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 60 npx vitest run --project unit test/chat-context.test.js 2>&1 | tail -10
```
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add srv/lib/chat-context.js test/chat-context.test.js
git commit -m "feat(172): append BRANCHING_GUIDANCE to system prompt for branch-relevant pages"
```

---

## Task 6: Branch state bus

**Files:**
- Create: `hugo-apps/src/tutorial-branches/branch-state-bus.ts`
- Test: `hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts`

Tiny module exporting `publishBranchState` (used by `BranchPicker.vue`) and `subscribeBranchState` (used by the page-level reader script in u1-object-page.html). Uses `document.dispatchEvent` + `addEventListener` for decoupled cross-component state.

- [ ] **Step 1: Write failing tests**

Create `hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts` with three cases:

1. **Publish + subscribe round-trip** — register a subscriber, publish a state object, assert the subscriber received the same shape (branchPointId / groupKey / currentBranch / recommendedBranch).
2. **Multiple subscribers** — register two subscribers, publish once, assert both received the state.
3. **Unsubscribe stops delivery** — register, immediately unsubscribe, publish, assert nothing received.

Use `// @vitest-environment happy-dom` at the top so `document.addEventListener` works.

- [ ] **Step 2: Run failing test**

```bash
cd D:/projects/tutorials-poc && D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts 2>&1 | tail -8
```
Expected: FAIL — module not found. (Per the worktree test-environment lesson from PR 3 Task 13: ALWAYS run via the project's root `node_modules/.bin/vitest` with `--project unit`, never `npx vitest` from `hugo-apps/`.)

- [ ] **Step 3: Implement the bus**

Create `hugo-apps/src/tutorial-branches/branch-state-bus.ts`:

```typescript
// hugo-apps/src/tutorial-branches/branch-state-bus.ts
//
// Issue #172 PR 4 — cross-component state bus for branch picker → page reader.
// BranchPicker.vue calls publishBranchState() whenever its selected or
// recommended branch changes. The page-level script in u1-object-page.html
// calls subscribeBranchState() to maintain a Map per branchPointId, which
// opGetCurrentStep() and joule.js#readPageContext both read.
//
// Uses CustomEvent on document — no global window namespace pollution,
// no Vue dependency in the subscriber. Tree-shakable (subscribe path stays
// out of the island bundle when the island only publishes).
//
// Spec: docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md §4.4

export interface BranchState {
  branchPointId: string;
  groupKey: string;
  currentBranch: string;
  recommendedBranch: string | null;
}

const EVENT = 'branch:state-change';

export function publishBranchState(state: BranchState): void {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: state }));
}

export function subscribeBranchState(handler: (state: BranchState) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<BranchState>).detail);
  document.addEventListener(EVENT, listener);
  return () => document.removeEventListener(EVENT, listener);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/projects/tutorials-poc && D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts 2>&1 | tail -8
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add hugo-apps/src/tutorial-branches/branch-state-bus.ts hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts
git commit -m "feat(172): branch-state-bus for cross-component state observation"
```

---

## Task 7: BranchPicker.vue publishes state

**Files:**
- Modify: `hugo-apps/src/tutorial-branches/BranchPicker.vue`

Wire `publishBranchState` calls into the picker's lifecycle so the page reader sees current/recommended branch transitions.

- [ ] **Step 1: Inspect existing state-set sites**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && grep -n "selectedKey.value\|recommendedKey.value\|onMounted\|onItemClick" hugo-apps/src/tutorial-branches/BranchPicker.vue
```

Expected: lines around 70, 79, and the end of `onItemClick`.

- [ ] **Step 2: Add the publish call**

In `hugo-apps/src/tutorial-branches/BranchPicker.vue`:

1. Add import alongside existing imports at the top:

```typescript
import { publishBranchState } from './branch-state-bus.js';
```

2. Add a helper just above `function onItemClick`:

```typescript
function publishCurrent() {
  publishBranchState({
    branchPointId: props.branchPointId,
    groupKey: props.groupKey,
    currentBranch: selectedKey.value,
    recommendedBranch: recommendedKey.value,
  });
}
```

3. At the end of the `onMounted` async block (after the existing recommendation-adopt logic), add:

```typescript
publishCurrent();  // [#172 PR 4] always publish initial state
```

4. At the end of `onItemClick` (after `localStorage.setItem`), add:

```typescript
publishCurrent();  // [#172 PR 4]
```

- [ ] **Step 3: Run existing BranchPicker tests to ensure no regression**

```bash
cd D:/projects/tutorials-poc && D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/tutorial-branches/__tests__/BranchPicker.test.ts 2>&1 | tail -8
```
Expected: 5 tests still pass.

- [ ] **Step 4: Smoke the Vite build to verify chunk budget**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/hugo-apps && timeout 90 npm run build 2>&1 | grep "tutorial-branches.js"
```
Expected: `tutorial-branches.js: <N> bytes gzipped (budget 12288)` — should be ~3.0 KB or under (was 2.86 KB after #303).

If `npm install` is needed in hugo-apps first, run it once: `cd hugo-apps && npm install --no-audit --no-fund`.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add hugo-apps/src/tutorial-branches/BranchPicker.vue
git commit -m "feat(172): BranchPicker publishes branch state changes via the bus"
```

---

## Task 8: Page-level reader (u1-object-page.html) + altgroups-count attribute (baseof.html)

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`
- Modify: `hugo/layouts/_default/baseof.html`

Replace the existing `window.opGetCurrentStep` block with a bus-aware version. Maintain a `latestBranchState` Map keyed by branchPointId. Expose `window.opGetCurrentStepBranchContext` for `joule.js#readPageContext`. Add `data-altgroups-count` to the `<html>` tag.

- [ ] **Step 1: Inspect current `opGetCurrentStep` (lines 693-700 of u1-object-page.html)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && sed -n '690,705p' hugo/layouts/tutorials/u1-object-page.html
```

- [ ] **Step 2: Replace `opGetCurrentStep`**

Replace the existing `window.opGetCurrentStep = function () { ... };` block (around lines 695-700) with a bus-aware version that:

1. Maintains `const latestBranchState = new Map();` keyed by branchPointId.
2. Listens for `branch:state-change` events and stores `e.detail` keyed by `e.detail.branchPointId`.
3. Provides a helper `getStepBranchContext(stepNum)` that finds `<div class="tutorial-branch-mount" data-branch-point-id="...">` inside the step's body and returns the matching Map entry (or null).
4. `opGetCurrentStep` returns `{ slug: tutorialSlug, n, heading, branchContext? }` — adds `branchContext` only when the helper returns non-null.
5. Exposes `window.opGetCurrentStepBranchContext = getStepBranchContext;` for `joule.js#readPageContext`.

The block sits inside the existing `<script>` tag at the bottom of u1-object-page.html. Keep the `tutorialSlug` and `getCurrentStep` references intact (they're already in scope from earlier in the script).

- [ ] **Step 3: Add `data-altgroups-count` to baseof.html**

In `hugo/layouts/_default/baseof.html`, find the `<html>` tag (lines 2-7). Add a new attribute alongside `data-page-step-count`. The attribute reflects the number of alt-groups on the current page:

```hugo
  data-altgroups-count="{{ if eq .Type "tutorials" }}{{ with .Params.missionAltGroups }}{{ len . }}{{ else }}0{{ end }}{{ else if or (eq .Type "missions") (eq .Type "groups") }}{{ with .Params.altGroups }}{{ len . }}{{ else }}0{{ end }}{{ else }}0{{ end }}"
```

The expression handles three page types:
- Tutorial pages → reads `missionAltGroups` (PR 2/3 plumbed this; carries the count of alt-groups in the parent mission, surfaced for the tutorial's chat-context use case).
- Mission/group pages → reads `altGroups` (PR 2 plumbed this onto mission frontmatter).
- Other pages → 0.

**Verify the field name** by inspecting one tutorial markdown file in the local cache before committing:

```bash
grep -c "missionAltGroups\|altGroups:" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/.tutorial-cache/*.md 2>/dev/null | head -3
```

If `missionAltGroups` is empty across the cache (PR 2 plumbed alt-groups onto _nav.json but maybe not onto tutorial frontmatter), re-confirm by reading `scripts/parsers/cap.ts` and adjust the template expression to match.

If altGroups data isn't easily reachable from baseof.html, fall back: just read tutorial-data JSON in `joule.js#readPageContext` (Task 9 Step 5) by counting `step.branchPointId` entries. Document the chosen path in the commit message.

- [ ] **Step 4: Hugo build smoke**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/hugo && timeout 30 ./hugo --quiet 2>&1 | tail -3
```
Expected: 0 errors. (If `./hugo` binary isn't present in the worktree, skip — the Hugo template syntax is straightforward; CI catches any breakage.)

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add hugo/layouts/tutorials/u1-object-page.html hugo/layouts/_default/baseof.html
git commit -m "feat(172): page reader maintains branch state Map + emits altgroups-count"
```

---

## Task 9: Joule starter prompts + joule.js integration

**Files:**
- Modify: `hugo/layouts/partials/joule-starters.html`
- Modify: `hugo/static/js/joule.js`
- Test: `hugo-apps/src/tutorial-branches/__tests__/joule-starter-substitution.test.ts` (new)

Add a new `tutorial-step-with-branch` starter kind. Switch starter kind in `openWithStepContext` based on `branchContext` presence. Extend `substituteStarter` to handle `{currentLabel}/{recommendedLabel}/{branchLabel}`. Suppress differential prompts when current === recommended. Extend `readPageContext` to attach `branchContext`.

- [ ] **Step 1: Add the new starter kind**

In `hugo/layouts/partials/joule-starters.html`, after the existing `tutorial-step` array, add:

```json
"tutorial-step-with-branch": [
  "Why is {recommendedLabel} recommended for me here?",
  "What's the difference between {currentLabel} and {recommendedLabel}?",
  "Should I switch from {currentLabel} to {recommendedLabel}?"
],
```

(Mind the trailing comma — the next key is `search`.)

- [ ] **Step 2: Switch starter kind based on branchContext**

In `hugo/static/js/joule.js`, find `openWithStepContext(ctx)` (around line 28). Replace with a version that picks the kind dynamically:

```javascript
openWithStepContext(ctx) {
  const kind = ctx && ctx.branchContext ? 'tutorial-step-with-branch' : 'tutorial-step';
  const opts = { starterContext: { kind: kind, vars: ctx || {} } };
  if (!this._ready) { this._pendingOpen = opts; return; }
  _openImpl(opts);
},
```

- [ ] **Step 3: Extend `substituteStarter` for branch labels**

Find `function substituteStarter(text, vars)` (around line 342). Extend it to handle three new substitution vars: `{currentLabel}`, `{recommendedLabel}`, `{branchLabel}`. The labels are looked up via a helper `lookupBranchLabels(branchContext)` that reads the `<script id="tutorial-data">` JSON, finds the step matching `branchContext.branchPointId`, and maps `currentBranch` / `recommendedBranch` keys to `branches[].label`. When `vars.branchContext` is absent, strip the placeholders cleanly (so `tutorial-step` prompts in the same template don't render `{recommendedLabel}` literally).

The `{branchLabel}` fallback chain is `recommendedLabel → currentLabel → ''`.

- [ ] **Step 4: Suppress differential prompts when current === recommended**

Find `function renderStarters(starterCtx)` (around line 352). After the existing `list` selection but before the slice/loop, add a filter:

```javascript
const vars = starterCtx && starterCtx.vars;
if (vars && vars.branchContext &&
    vars.branchContext.currentBranch === vars.branchContext.recommendedBranch) {
  list = list.filter(t => !(t.includes('{currentLabel}') && t.includes('{recommendedLabel}')));
}
```

This drops "Should I switch from X to X?"-style prompts. Keep "Why is X recommended for me here?" since it's still useful when current === recommended.

- [ ] **Step 5: Attach `branchContext` and `altGroupsCount` in `readPageContext`**

Find `function readPageContext()` (around line 276). In the `if (ctx.kind === 'tutorial')` block (after the existing `currentStepText` logic around line 326), add:

```javascript
if (ctx.currentStep && typeof window.opGetCurrentStepBranchContext === 'function') {
  const bc = window.opGetCurrentStepBranchContext(ctx.currentStep);
  if (bc) ctx.branchContext = bc;
}
```

After all the kind-specific blocks, before the final `return ctx;`, add:

```javascript
if (ctx.kind === 'mission' || ctx.kind === 'group') {
  const n = Number(html.dataset.altgroupsCount || '0');
  if (n > 0) ctx.altGroupsCount = n;
}
```

- [ ] **Step 6: Write substitution unit tests**

Create `hugo-apps/src/tutorial-branches/__tests__/joule-starter-substitution.test.ts` exercising 4 cases:

1. `{recommendedLabel}` substitution from tutorial-data JSON → maps `recommendedBranch: 'hana'` to `'HANA Cloud'`.
2. `{currentLabel}` and `{recommendedLabel}` together (when they differ) → `'Should I switch from PostgreSQL to HANA Cloud?'`.
3. No `branchContext` given → placeholders stripped to empty string (test asserts `'Why is  the pick?'` after stripping).
4. Missing `tutorial-data` element → graceful empty substitution.

Inline copies of the `substituteStarter` and `lookupBranchLabels` helpers in the test file (since `joule.js` is a plain ES script, not a module — the helpers can't be imported). Add `// @vitest-environment happy-dom` so `document.body` works. Tests assert the contract; if `joule.js` drifts, the tests fail.

Avoid setting `document.body.innerHTML = ''` in `beforeEach` — use `document.body.replaceChildren()` instead (per the project's security-hook policy on innerHTML). Each test creates a fresh `<script id="tutorial-data">` element via `createElement` + `appendChild`.

- [ ] **Step 7: Run substitution tests**

```bash
cd D:/projects/tutorials-poc && D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/tutorial-branches/__tests__/joule-starter-substitution.test.ts 2>&1 | tail -8
```
Expected: 4 tests pass.

- [ ] **Step 8: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add hugo/layouts/partials/joule-starters.html hugo/static/js/joule.js hugo-apps/src/tutorial-branches/__tests__/joule-starter-substitution.test.ts
git commit -m "feat(172): joule branch-aware starters + readPageContext branchContext"
```

---

## Task 10: Hybrid HANA round-trip test

**Files:**
- Create: `test/hybrid/branch-joule-tool.test.js`

Verify the tool handler against real HANA. Catches SQL drift in `BranchSpecs` JSON column reads, `BranchDecisions` writes, and the `Missions/CompletionPaths/CompletionPathItems` aggregation that the in-memory SQLite tolerates silently. Gated on `ALLOW_HYBRID_WRITES=true`.

- [ ] **Step 1: Create the hybrid test**

Create `test/hybrid/branch-joule-tool.test.js` modeled on `test/hybrid/branches-decide.test.js` (PR 3's analog hybrid test). Pattern:

- `cds.test('serve', '--project', '.', '--profile', 'hybrid')` at module top.
- `RUN_ID = ${Date.now()}-<random suffix>`.
- `PREFIX = '__test__joule_<runid>'`.
- `it.skipIf(!writesEnabled)` gating where `writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true'`.
- `beforeAll`: `isSafeForWrites()` guard from `test/hybrid/_guard.js`; INSERT into `BranchSpecs` with one branchPoint + one skipPoint.
- `it`: call `getBranchRecommendationHandler({ args: { tutorialSlug: prefixed-slug }, user: null })`; assert `branchPoints[0].id` matches, `picked` is non-empty, telemetry row written. Don't bother with the chat orchestrator round-trip — testing tool registration is covered by Task 4's unit test, and the LLM round-trip is out of scope.
- `afterAll`: DELETE BranchSpecs row.

- [ ] **Step 2: Syntax-check (don't run hybrid)**

```bash
node --check D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/test/hybrid/branch-joule-tool.test.js
```
Expected: no output (parse OK). Do NOT run the hybrid project — Tom triggers hybrid manually after deploy.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add test/hybrid/branch-joule-tool.test.js
git commit -m "test(172): hybrid round-trip for getBranchRecommendation tool"
```

---

## Task 11: srv-qa cp list

**Files:**
- Modify: `.deploy/mta.yaml`

Per [[feedback_srv_qa_cp_list_recurring]] — every new srv file needs to be in the srv-qa cp list, otherwise QA boot crashes.

- [ ] **Step 1: Inspect current cp list**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && grep -n "branch/condition\|branch/decide\|branch/joule" .deploy/mta.yaml
```

PR 3's cp list contains: `condition.js engine.js ranker.js user-state.js loaders.js mission-detail.js slug-key.js decide.js`. PR 4 adds `joule-tool.js`.

- [ ] **Step 2: Add `joule-tool.js` to the cp segment**

In `.deploy/mta.yaml`, find the `bash -c "mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp ../../srv/lib/branch/...` line. Append `../../srv/lib/branch/joule-tool.js` to the branch/* file list (alongside `decide.js`, before `srv/lib/branch/`).

- [ ] **Step 3: Verify**

```bash
grep -q "branch/joule-tool.js" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/.deploy/mta.yaml && echo OK || echo MISSING
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add .deploy/mta.yaml
git commit -m "chore(172): register joule-tool.js in srv-qa cp list"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/developers/operations/testing-endpoints.md`

Per spec §9.2 — document the new chat tool. Mirror the existing tool docs in the same file.

- [ ] **Step 1: Inspect existing chat-tool documentation**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && grep -n "getRelevantSteps\|checkCode\|chat tool" docs/developers/operations/testing-endpoints.md | head -10
```

- [ ] **Step 2: Append a `getBranchRecommendation` subsection**

Append in the appropriate section of `docs/developers/operations/testing-endpoints.md` (typically a "Chat tools" or "Joule tools" section if one exists, otherwise add it next to the existing endpoint reference). Include:

- **Tool name + registration gate**: `getBranchRecommendation` is registered when `ChatSettings.enabled = true && ChatSettings.branchingEnabled = true`.
- **Params**: `missionSlug?`, `tutorialSlug?`, `branchPointId?`. At least one required. `branchPointId` requires `tutorialSlug`.
- **Return shape**: `{ branchPoints: [{ id, picked, reason, confidence, allBranches: [{key, label}] }], altGroups: [{ id, groupKey, picked, reason, confidence, allBranches: [{key, label}] }], skipPoints: [{ stepNumber, skip, reason, skipLabel?, skipReason? }], note?, error? }`.
- **Telemetry**: writes one `BranchDecisions` row per recommendation with `source: 'jouleTool'`. Skip-point telemetry only when `skip === true`.
- **Error envelopes**: `error: 'requires_at_least_one_of: ...'`, `error: 'branchPointId requires tutorialSlug'`, `error: 'unknown_branch_point: <id>'`.
- **Empty-shape envelopes** (not errors): `note: 'tutorial_has_no_branches'`, `note: 'mission_not_found'`, `note: 'mission_has_no_alt_groups'`.
- **Default-off behavior**: when `branchingEnabled = false`, the tool is not registered; the LLM falls back to general guidance.

Length target: ~30-40 lines, similar to existing tool docs.

- [ ] **Step 3: Build the docs site to verify no dead links**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 90 npm run docs:build 2>&1 | tail -5
```
Expected: success. If a dead-link error fires that's pre-existing on `main`, verify via `git stash` baseline run — not blocking PR 4.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git add docs/developers/operations/testing-endpoints.md
git commit -m "docs(172): testing-endpoints reference for getBranchRecommendation tool"
```

---

## Task 13: Final-branch sanity, smoke, push, PR

- [ ] **Step 1: Run the full PR 4 unit-test surface**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/branch-joule-tool.test.js test/chat-orchestrator-tools.test.js test/chat-context.test.js hugo-apps/src/tutorial-branches/__tests__/branch-state-bus.test.ts hugo-apps/src/tutorial-branches/__tests__/joule-starter-substitution.test.ts hugo-apps/src/tutorial-branches/__tests__/BranchPicker.test.ts 2>&1 | tail -10
```
Expected: ~30 tests pass total (12 joule-tool + 2 orchestrator + 4 context + 3 bus + 4 substitution + 5 BranchPicker).

- [ ] **Step 2: Run the broader unit suite to catch any regressions**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && timeout 240 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/branch-loaders.test.js test/branches-decide.test.js test/build-catalog-altgroup-shape.test.js test/build-catalog-mission-detail.test.js test/branch-slug-key.test.js test/admin-altgroup-validator.test.js scripts/parsers/__tests__/branches.test.ts scripts/parsers/__tests__/compose.test.ts 2>&1 | tail -10
```
Expected: green; PR 1+2+3 substrate untouched.

- [ ] **Step 3: Verify line endings**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && file srv/lib/branch/joule-tool.js test/branch-joule-tool.test.js test/hybrid/branch-joule-tool.test.js hugo-apps/src/tutorial-branches/branch-state-bus.ts
```
Expected: all `ASCII text` or `UTF-8 text` — never CRLF.

- [ ] **Step 4: Verify cp list**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && grep -q "branch/joule-tool.js" .deploy/mta.yaml && echo OK || echo MISSING
```
Expected: `OK`.

- [ ] **Step 5: Verify Vite chunk-budget**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4/hugo-apps && timeout 90 npm run build 2>&1 | grep "tutorial-branches.js"
```
Expected: gzipped size ≤ 12288 bytes (the budget guard).

- [ ] **Step 6: Push the branch and open the PR**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr4 && git branch --show-current
git push -u origin feat/172-pr4-joule-narration

gh pr create --base main --title "feat(172): Joule narration tool — getBranchRecommendation chat tool + branch-aware FAB starters" --body "PR 4 of issue #172. Default-off via ChatSettings.branchingEnabled — prod unchanged on merge.

## What ships

- Server: srv/lib/branch/joule-tool.js exports GET_BRANCH_RECOMMENDATION_TOOL + getBranchRecommendationHandler. Composes engine queries directly; reads BranchSpecs (PR 3) for tutorial scope, Missions/CompletionPaths/CompletionPathItems (PR 2 substrate) for mission scope; calls pickBranch + evaluateSkip; writes BranchDecisions rows with source: jouleTool.
- Chat orchestrator: tool registration + dispatch in chat-orchestrator.js. BRANCHING_GUIDANCE line in chat-context.js for tutorial pages with branchContext + mission/group pages with altGroupsCount > 0.
- Vue island: branch-state-bus.ts for cross-component CustomEvent observation. BranchPicker.vue publishes state on mount + click.
- Hugo + joule.js: opGetCurrentStep adds branchContext. New tutorial-step-with-branch starter kind. substituteStarter handles 3 new label vars + suppresses differential prompts when current === recommended. readPageContext attaches branchContext + altGroupsCount.
- Docs: testing-endpoints.md reference for the new chat tool.
- mta.yaml: joule-tool.js in srv-qa cp list.

## What does NOT ship

- PR 5 (analytics tile reading BranchDecisions.source).
- PR 6 (profile fields populated end-to-end + pilot enablement).

## Tests

- ~25 unit pass (12 tool + 2 orchestrator + 4 context + 3 bus + 4 substitution + 5 BranchPicker regression).
- 1 hybrid test (ALLOW_HYBRID_WRITES=true gated).
- Vue island chunk budget: tutorial-branches.js ~3.0 KB gzipped (well under 12 KB cap).

## Manual checklist (post-deploy in DEV with branchingEnabled=true + a seeded fixture)

1. Visit a seeded branched tutorial; click Joule step-help FAB. Verify three branch-aware starters render with correct labels.
2. Click 'Why is X recommended for me here?' → LLM response cites the engine's reason.
3. Toggle to a non-recommended branch via the picker → click FAB → verify 'Should I switch from X to Y?' prompt renders.
4. Visit a mission page with alt-groups → ask 'what's next in this mission?' → LLM uses the tool, mentions recommended branches.
5. Toggle branchingEnabled = false via admin → reload → verify FAB still works but no branch-aware starters; LLM doesn't have the tool.
6. Inspect BranchDecisions table after exercising scenarios — rows with source = jouleTool flowing.

Refs #172 · spec: docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md"
```

---

## Definition of done for PR 4

- [ ] All 14 tasks (0-13) complete and committed
- [ ] PR 4 unit suite green; ~25 new tests
- [ ] PR 1+2+3 substrate tests still green (no regression)
- [ ] Hybrid test syntax-checks via `node --check`
- [ ] No new npm dependencies
- [ ] `.deploy/mta.yaml` srv-qa cp list contains `joule-tool.js`
- [ ] `tutorial-branches.js` chunk budget ≤ 12 KB gzipped
- [ ] `docs/developers/operations/testing-endpoints.md` updated
- [ ] PR opened against `main`

---

## Reviewer addendum (apply before starting)

**A. Test environment** — Per [[the worktree test-environment lesson from PR 3 Task 13]], ALWAYS run hugo-apps tests via `D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit <path>` from the project root. Do NOT use `npx vitest` from `hugo-apps/` — that fetches a different vitest binary without the project's plugin config and tests fail confusingly.

**B. Slug normalization** — `getBranchRecommendationHandler` lowercases `tutorialSlug` and `missionSlug` at handler entry per CLAUDE.md tutorial-slug rule. Tests verify with uppercase fixtures.

**C. ChatSettings singleton ID** — `'00000000-0000-0000-0000-00000000c8a7'`. Use a `CHAT_SETTINGS_ID` constant in tests (mirrors PR 2/3 convention).

**D. BranchDecisions write best-effort** — Mirror `decide.js` pattern: try/catch + `LOG.warn` on failure. Tool result still returned to LLM. Don't block on telemetry.

**E. Engine errors degrade defensively** — `pickBranch` and `evaluateSkip` are total per PR 1 contract, but wrap in try/catch + log.warn anyway: degrade to `{ picked: branches[0]?.key, reason: { kind: 'default' }, confidence: 0 }` on throw.

**F. Mission scope mirrors mission-detail.js groupByAlt** — Read `srv/lib/branch/mission-detail.js` lines 130–148 for the exact grouping pattern. Don't re-derive it; copy the shape (skip null altGroupKey items, group by `(itemOrder, altGroupKey)`).

**G. Vue island chunk budget** — adding `branch-state-bus.ts` to BranchPicker should be neutral. The subscribe path tree-shakes since the island only publishes. If the budget guard fires, look for accidental re-imports first before splitting.

**H. PreToolUse hook** — Editing files via this harness may trip on certain JavaScript regex method names and on direct `innerHTML =` assignments. If the hook blocks an Edit, use `replaceChildren()` instead of `innerHTML = ''`, and prefer `String.prototype.match()` / `matchAll()` for regex iteration. Algorithm correctness is what matters; the test contracts in each task are the source of truth.

**I. The substituteStarter helper duplication is intentional v1** — joule.js is plain ES script, not a module, so the helper can't be imported into a test. The test file inlines the helper definitions; if joule.js drifts, the tests fail and the implementer reconciles. PR 4+ may modularize joule.js separately.

**J. Hugo template path for `data-altgroups-count`** — confirm field name (`missionAltGroups` vs `altGroups`) by inspecting one tutorial's frontmatter in `.tutorial-cache/` before committing Task 8 Step 3.
