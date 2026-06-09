# 172 PR 4 — Joule Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Joule conversationally narrates branch recommendations through a new `getBranchRecommendation` chat tool. The LLM never decides — it asks `pickBranch` and frames the result. The step-help FAB seeds the chat with branch context. Default-off via `ChatSettings.enabled && branchingEnabled`.

**Architecture:** One new tool registered in `chat-orchestrator.js` alongside the existing tools (search-tutorials, getUserProgress, getRelevantSteps, checkCode). Tool handler calls PR 1's `pickBranch` and returns structured `{ branchPoints: [{ id, picked, reason, allBranches }] }` to the LLM. Step-help FAB extends `window.opGetCurrentStep()` to include `branchContext`. The system prompt picks up a small additional rule for "when the user asks which path to take."

**Tech Stack:** CAP Node.js, AI SDK, vitest unit + hybrid, vanilla JS for FAB.

**Spec section refs:** §5.4 (Joule narration), §3 architectural invariants ("LLM never decides"), §9.1 row 4.

**Depends on:** PR 1 + PR 2 + PR 3 merged (engine, mission detail endpoint, tutorial decide endpoint).

---

## File Structure

**Create (3 files):**
- `srv/lib/branch/joule-tool.js` — `dispatchGetBranchRecommendation` handler + tool definition export
- `test/branch-joule-tool.test.js` — unit project tests for the tool dispatch
- `test/hybrid/branch-joule-tool.test.js` — hybrid test against real chat orchestrator

**Modify (5 files):**
- `srv/lib/chat-orchestrator.js` — register `GET_BRANCH_RECOMMENDATION_TOOL` when both flags on; wire dispatch
- `srv/lib/chat-context.js` — extend system prompt with one paragraph on branching
- `hugo-apps/src/joule-chat/` (or wherever `window.opGetCurrentStep` lives) — extend payload with `branchContext`
- `.deploy/mta.yaml` — register `srv/lib/branch/joule-tool.js` in srv-qa cp list
- `docs/developers/operations/testing-endpoints.md` — document the new tool

**No new npm dependencies.**

---

## Task 1: Joule chat tool — dispatch handler

**Files:**
- Create: `srv/lib/branch/joule-tool.js`
- Test: `test/branch-joule-tool.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/branch-joule-tool.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { dispatchGetBranchRecommendation } from '../srv/lib/branch/joule-tool.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID  = '11111111-9500-0000-0000-000000000001';
const PATH_ID     = '22222222-9500-0000-0000-000000000001';
const TUT_HANA_ID = '33333333-9500-0000-0000-000000000020';
const TUT_PG_ID   = '33333333-9500-0000-0000-000000000030';

describe('dispatchGetBranchRecommendation', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials, ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: TUT_HANA_ID, legacyId: 99520, slug: '__test__-jt-hana', title: 'HANA', status: 'ACTIVE' },
      { ID: TUT_PG_ID,   legacyId: 99530, slug: '__test__-jt-pg',   title: 'PG',   status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({ ID: MISSION_ID, legacyId: 99500, title: '__TEST__ JT Mission', slug: '__test__-jt-mission', published: true });
    await INSERT.into(CompletionPaths).entries({ ID: PATH_ID, legacyId: 99501, mission_ID: MISSION_ID, name: 'P1', slug: '__test__-jt-p1' });
    await INSERT.into(CompletionPathItems).entries([
      { ID: '44444444-9500-0000-0000-000000000020', legacyId: 99551, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_HANA_ID, itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud', altCondition: "profile.deployment == 'cloud'" },
      { ID: '44444444-9500-0000-0000-000000000030', legacyId: 99552, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_PG_ID,   itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
    ]);
    await UPSERT.into(ChatSettings).entries({ ID: 'singleton', enabled: true, branchingEnabled: true });
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_HANA_ID, TUT_PG_ID] } });
  });

  it('returns branchPoints with picked + allBranches when missionSlug is provided', async () => {
    const out = await dispatchGetBranchRecommendation(
      { missionSlug: '__test__-jt-mission' },
      { id: 'anonymous' }
    );
    expect(out.branchPoints).toHaveLength(1);
    expect(out.branchPoints[0].picked).toMatch(/hana-cloud|postgresql/);
    expect(out.branchPoints[0].allBranches).toHaveLength(2);
  });

  it('returns empty branchPoints when neither slug is provided', async () => {
    const out = await dispatchGetBranchRecommendation({}, { id: 'anonymous' });
    expect(out.branchPoints).toEqual([]);
    expect(out.error).toBe('missing_context');
  });

  it('returns error_disabled when branchingEnabled is false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: 'singleton', enabled: true, branchingEnabled: false });
    const out = await dispatchGetBranchRecommendation(
      { missionSlug: '__test__-jt-mission' },
      { id: 'anonymous' }
    );
    expect(out.error).toBe('branching_disabled');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/branch-joule-tool.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/lib/branch/joule-tool.js`**

```javascript
// srv/lib/branch/joule-tool.js
//
// Joule chat tool: getBranchRecommendation — narrates which branch is recommended
// for the current user. The LLM NEVER decides; it asks pickBranch and frames the
// result. Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.4

import cds from '@sap/cds';
import { pickBranch } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';

const LOG = cds.log('branch-joule-tool');

export const GET_BRANCH_RECOMMENDATION_TOOL = {
  type: 'function',
  function: {
    name: 'getBranchRecommendation',
    description:
      'When the user is on a tutorial or mission with branching, return which branch is recommended for them and why. ' +
      'Use this when the user asks "which path should I take", "what next in this mission", "should I do the cloud or on-prem version", or similar. ' +
      'Returns a list of branch points (most often just one) with the recommended branch key, the reason, and the full set of alternatives. ' +
      'You frame the result conversationally for the user; do not just dump the JSON.',
    parameters: {
      type: 'object',
      properties: {
        missionSlug:   { type: 'string', description: 'Mission slug if the user is on a mission page or asking about a mission.' },
        tutorialSlug:  { type: 'string', description: 'Tutorial slug if the user is on a tutorial page.' },
        branchPointId: { type: 'string', description: 'Optional — a specific branch point id when the user is asking about one branch in particular.' },
      },
    },
  },
};

/**
 * Dispatch handler for the chat-orchestrator. Returns one of:
 *   { branchPoints: [{ id, picked, reason, confidence, allBranches: [{key,label}] }], error?: undefined }
 *   { branchPoints: [], error: 'missing_context' | 'branching_disabled' | 'mission_not_found' | 'tutorial_not_found' | 'tool_failed' }
 */
export async function dispatchGetBranchRecommendation(args, user) {
  if (!args?.missionSlug && !args?.tutorialSlug) {
    return { branchPoints: [], error: 'missing_context' };
  }

  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
    if (!settings?.branchingEnabled) return { branchPoints: [], error: 'branching_disabled' };

    const loaders = makeBranchLoaders();
    const cleanUser = user?.id && user.id !== 'anonymous' ? user : null;
    const userState = await buildUserState(cleanUser, loaders);

    if (args.missionSlug) {
      return await narrateMission(args.missionSlug, userState, loaders, args.branchPointId);
    }
    if (args.tutorialSlug) {
      return await narrateTutorial(args.tutorialSlug, userState, loaders, args.branchPointId);
    }
  } catch (err) {
    LOG.error('dispatchGetBranchRecommendation', err);
    return { branchPoints: [], error: 'tool_failed' };
  }

  return { branchPoints: [], error: 'missing_context' };
}

async function narrateMission(slug, userState, loaders, filterBranchPointId) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
  const mission = await SELECT.one.from(Missions).where({ slug });
  if (!mission) return { branchPoints: [], error: 'mission_not_found' };

  const paths = await SELECT.from(CompletionPaths).where({ mission_ID: mission.ID });
  if (!paths.length) return { branchPoints: [], missionSlug: slug };

  const allItems = await SELECT.from(CompletionPathItems).where({ path_ID: paths[0].ID }).orderBy('itemOrder');

  const tutIds = [...new Set(allItems.map(i => i.tutorial_ID).filter(Boolean))];
  const tuts = tutIds.length
    ? await SELECT.from(Tutorials).columns('ID', 'slug', 'title').where({ ID: { in: tutIds } })
    : [];
  const tutById = new Map(tuts.map(t => [t.ID, t]));

  const grouped = groupByAlt(allItems);
  const out = [];
  for (const g of grouped) {
    if (g.altGroupKey == null) continue;
    const id = `${slug}:${g.altGroupKey}:${g.items[0].itemOrder}`;
    if (filterBranchPointId && filterBranchPointId !== id) continue;

    const branches = g.items.map(i => ({
      key: slugifyKey(i.altGroupLabel || ''),
      label: i.altGroupLabel || '',
      condition: i.altCondition || null,
      embeddingHint: tutById.get(i.tutorial_ID)?.slug || null,
      tutorialSlug: tutById.get(i.tutorial_ID)?.slug || null,
    }));

    const branchPoint = { id, surface: 'missionAltGroup', branches };
    const decision = await pickBranch(branchPoint, userState, { missionSlug: slug }, {
      rankBranches: (bp, st, ctx) => rankBranches(bp, st, ctx, loaders),
    });

    out.push({
      id,
      picked: decision.picked,
      reason: decision.reason,
      confidence: decision.confidence,
      allBranches: branches.map(({ embeddingHint, ...keep }) => keep),
    });
  }
  return { branchPoints: out, missionSlug: slug };
}

async function narrateTutorial(slug, userState, loaders, filterBranchPointId) {
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const tut = await SELECT.one.from(Tutorials).columns('ID').where({ slug: slug.toLowerCase() });
  if (!tut?.ID) return { branchPoints: [], error: 'tutorial_not_found' };

  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
  const branchMeta = meta?.branchPoints ? safeJSON(meta.branchPoints) : [];

  const out = [];
  for (const bp of branchMeta) {
    if (filterBranchPointId && filterBranchPointId !== bp.id) continue;

    const branches = bp.branches.map(b => ({
      key: b.key, label: b.label, condition: b.condition || null, embeddingHint: null,
    }));
    const branchPoint = { id: bp.id, surface: 'tutorialBranch', branches };
    const decision = await pickBranch(branchPoint, userState, { tutorialSlug: slug }, {
      rankBranches: (bp_, st_, ctx_) => rankBranches(bp_, st_, ctx_, loaders),
    });

    out.push({
      id: bp.id,
      picked: decision.picked,
      reason: decision.reason,
      confidence: decision.confidence,
      allBranches: branches.map(({ embeddingHint, ...keep }) => keep),
    });
  }

  return { branchPoints: out, tutorialSlug: slug };
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return []; } }

function groupByAlt(items) {
  const out = [];
  const seenKey = new Map();
  for (const it of items) {
    if (!it.altGroupKey) {
      out.push({ altGroupKey: null, itemOrder: it.itemOrder, items: [it] });
      continue;
    }
    const k = `${it.itemOrder}:${it.altGroupKey}`;
    if (seenKey.has(k)) {
      out[seenKey.get(k)].items.push(it);
    } else {
      seenKey.set(k, out.length);
      out.push({ altGroupKey: it.altGroupKey, itemOrder: it.itemOrder, items: [it] });
    }
  }
  return out;
}

function slugifyKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
```

- [ ] **Step 4: Run the dispatcher tests**

Run: `npx vitest run test/branch-joule-tool.test.js --project unit`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/joule-tool.js test/branch-joule-tool.test.js
git commit -m "feat(172): Joule getBranchRecommendation tool dispatcher"
```

---

## Task 2: Register the tool in chat-orchestrator

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`

- [ ] **Step 1: Inspect the existing tool registry**

Run:
```bash
grep -n "CHECK_CODE_TOOL\|toolsForContext\|dispatchTool" D:/projects/tutorials-poc/srv/lib/chat-orchestrator.js | head -10
```

The existing pattern: `toolsForContext()` returns the list of tools given context+settings; `dispatchTool(name, args, user)` is the central dispatcher.

- [ ] **Step 2: Import the tool definition + dispatcher**

At the top of `srv/lib/chat-orchestrator.js`, add:

```javascript
import { GET_BRANCH_RECOMMENDATION_TOOL, dispatchGetBranchRecommendation } from './branch/joule-tool.js';
```

- [ ] **Step 3: Register the tool when both flags are on**

In `toolsForContext()` (around line 176–198), inside the `try` block where it checks `settings?.codeCheckEnabled`, add:

```javascript
if (settings?.branchingEnabled) {
  tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
}
```

The chat tool requires `enabled: true` (chat-wide flag) AND `branchingEnabled: true`. The chat-wide flag is the gate that wraps `toolsForContext()` — when chat is disabled, the orchestrator never calls this function.

- [ ] **Step 4: Wire the dispatcher**

In `dispatchTool()` (the function with the `if (name === 'searchTutorials')` chain — search for it):

```javascript
if (name === 'getBranchRecommendation') {
  return dispatchGetBranchRecommendation(args, user);
}
```

Position this near the existing tool dispatchers (alphabetical or by feature; the codebase has a stable ordering pattern — match it).

- [ ] **Step 5: Run chat-orchestrator unit tests**

Run: `npx vitest run test/chat-orchestrator.test.js --project unit`
Expected: still green; the new tool is additive.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js
git commit -m "feat(172): register getBranchRecommendation tool in chat-orchestrator"
```

---

## Task 3: System prompt — branching guidance

**Files:**
- Modify: `srv/lib/chat-context.js`

- [ ] **Step 1: Find the existing prompt assembly**

Run:
```bash
grep -n "PROGRESS_GUIDANCE\|systemPrompt\|## Tools" D:/projects/tutorials-poc/srv/lib/chat-context.js | head -20
```

- [ ] **Step 2: Add a branching-guidance paragraph**

Locate the section that lists tool guidance (similar to the existing `PROGRESS_GUIDANCE`). Add a sibling constant:

```javascript
const BRANCHING_GUIDANCE = `
When the user is on a mission or tutorial that has branching paths (alt-groups, branch blocks, or skip-runs), call getBranchRecommendation to fetch the system's recommendation. Then narrate it conversationally:
- If the reason is a 'condition' (deterministic match), say plainly why ("Because you finished node-getting-started, you can skip step 4").
- If the reason is 'ranker', frame it as a soft recommendation ("Based on what you've completed before, I'd suggest the HANA branch — but PostgreSQL is fully fine if you'd rather learn that").
- If the reason is 'default', do NOT pretend to recommend — say something like "Either branch works; pick whichever fits your stack."
- ALWAYS surface the alternatives. Never gate the user behind your pick. Branching is a hint, not a fork.
- NEVER decide the branch yourself before calling the tool. The tool's pickBranch is the authority.
`;
```

Wire it into the prompt alongside the other guidance constants when `branchingEnabled` is on (mirror the codeCheck/RAG flag-gated guidance):

```javascript
if (settings?.branchingEnabled) {
  segments.push(BRANCHING_GUIDANCE);
}
```

(Adjust to match the existing pattern — the precise hook location depends on how `chat-context.js` composes the prompt.)

- [ ] **Step 3: Run chat-context tests**

Run: `npx vitest run test/chat-context.test.js --project unit`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/chat-context.js
git commit -m "feat(172): system prompt guidance for branching narration"
```

---

## Task 4: Step-help FAB — extend opGetCurrentStep with branchContext

**Files:**
- Modify: `hugo-apps/src/joule-chat/` (or wherever `window.opGetCurrentStep` is defined; search for it)

- [ ] **Step 1: Find the FAB seed**

Run: `grep -rn "opGetCurrentStep\|window\\.opGet" D:/projects/tutorials-poc/hugo-apps D:/projects/tutorials-poc/hugo/static 2>/dev/null | head -10`

The function is exported on `window` so the chat-launcher can read the current page context when user clicks the FAB.

- [ ] **Step 2: Add `branchContext` to the returned object**

Inside `opGetCurrentStep`, when the page has branch points, augment the payload:

```typescript
function readBranchContext() {
  const dataEl = document.getElementById('tutorial-branch-points');
  if (!dataEl) return null;
  let branches: any[];
  try { branches = JSON.parse(dataEl.textContent || '[]'); } catch { return null; }
  if (!branches.length) return null;

  // Find the branch point closest to the current scroll position (the one
  // the user is likely asking about). Fall back to the first one.
  const mounts = Array.from(document.querySelectorAll('.tutorial-branch-mount'));
  let activeId: string | null = null;
  for (const m of mounts) {
    const rect = (m as HTMLElement).getBoundingClientRect();
    if (rect.top <= window.innerHeight / 2) activeId = m.getAttribute('data-branch-point-id');
  }
  if (!activeId && branches.length) activeId = branches[0].id;
  const active = branches.find(b => b.id === activeId);
  if (!active) return null;

  // Read the user's current selection from localStorage
  const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();
  const lsKey = `tut.branch.tutorial.${slug}.${active.id}`;
  const currentBranch = localStorage.getItem(lsKey);
  return {
    groupKey: active.groupKey,
    branchPointId: active.id,
    currentBranch,
    availableBranches: active.branches.map((b: any) => ({ key: b.key, label: b.label })),
  };
}

// Inside the existing opGetCurrentStep return:
return {
  /* existing fields: slug, stepNumber, heading */
  branchContext: readBranchContext(),
};
```

The chat orchestrator will receive this in the seed message, allowing the LLM to call `getBranchRecommendation` with the right `tutorialSlug` and `branchPointId` without asking the user.

- [ ] **Step 3: Smoke test**

Run `npm run dev`, open a tutorial without branches, click the Joule FAB. The seed should still work (no `branchContext` for non-branched tutorials, which is fine).

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/joule-chat/
git commit -m "feat(172): step-help FAB seeds chat with branchContext"
```

---

## Task 5: Hybrid test — real chat orchestrator round-trip

**Files:**
- Create: `test/hybrid/branch-joule-tool.test.js`

- [ ] **Step 1: Write the hybrid test**

```javascript
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { dispatchGetBranchRecommendation } from '../../srv/lib/branch/joule-tool.js';

const project = cds.test.in(__dirname).profile('hybrid');

describe.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
  'hybrid: getBranchRecommendation against real HANA',
  () => {
    it('survives a real query', async () => {
      if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');

      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await UPSERT.into(ChatSettings).entries({ ID: 'singleton', enabled: true, branchingEnabled: true });

      // Use a known mission slug (any seeded mission). The test only
      // asserts the call doesn't throw + returns a valid shape.
      const out = await dispatchGetBranchRecommendation(
        { missionSlug: 'btp-cap-getting-started' },
        { id: 'anonymous' }
      );
      expect(out).toBeDefined();
      expect(Array.isArray(out.branchPoints)).toBe(true);
    });
  }
);
```

- [ ] **Step 2: Run the hybrid test (if `cf login` is current)**

```bash
ALLOW_HYBRID_WRITES=true npx vitest run --project hybrid test/hybrid/branch-joule-tool.test.js
```

Expected: 1 test passes (or skips cleanly if no binding).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/branch-joule-tool.test.js
git commit -m "test(172): hybrid Joule tool round-trip"
```

---

## Task 6: srv-qa cp list

**Files:**
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Append `joule-tool.js` to the cp list**

- [ ] **Step 2: Verify**

```bash
grep -q "branch/joule-tool.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(172): register joule-tool in srv-qa cp list"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/developers/operations/testing-endpoints.md`

- [ ] **Step 1: Add a row to the chat-tools section**

Locate the existing chat-tools listing (search for `getRelevantSteps`, `getUserProgress`, `checkCode`). Add:

```markdown
| `getBranchRecommendation` | learner | `branchingEnabled` + `enabled` | Returns the recommended branch + the full set of alternatives for a mission alt-group or tutorial branch point. The LLM never decides — it asks pickBranch. |
```

- [ ] **Step 2: Add a help-text update for ChatSettings admin UI**

The admin Joule Chat Settings tile should explain `branchingEnabled`. In `app/admin/joule/` (Fiori Elements component), add a tooltip or quickInfo on the new field. (Spec §9.2 PR 4.) If there's no annotation file yet, skip — the admin UI auto-generates from the entity; just confirm the field renders.

- [ ] **Step 3: Build docs**

```bash
npm run docs:build
```

- [ ] **Step 4: Commit**

```bash
git add docs/developers/operations/testing-endpoints.md app/admin/joule/
git commit -m "docs(172): testing-endpoints reference for getBranchRecommendation"
```

---

## Task 8: Final-branch sanity, push, PR

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: green.

- [ ] **Step 2: Run smoke**

Run: `npx vitest run --project smoke test/smoke/chat.test.js`
Expected: still green; existing chat flow is unchanged when `branchingEnabled` is off.

- [ ] **Step 3: Verify no LF→CRLF, srv-qa registration**

```bash
file D:/projects/tutorials-poc/srv/lib/branch/joule-tool.js
grep -q "joule-tool.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 4: Push + PR**

```bash
git push origin feat/172-branching-paths-design
gh pr create \
  --title "feat(172): Joule getBranchRecommendation chat tool" \
  --body "PR 4 of #172 plan. See plan: docs/superpowers/plans/2026-06-09-172-branching-pr4-joule-narration.md" \
  --base main
```

---

## Definition of done for PR 4

- [ ] All 8 tasks complete and committed
- [ ] `npx vitest run --project unit` green; new tests contribute ~3 unit + 1 hybrid
- [ ] Tool registered iff `enabled && branchingEnabled`; absent otherwise
- [ ] System prompt contains branching guidance only when `branchingEnabled`
- [ ] FAB seed includes `branchContext` on branched tutorials
- [ ] PR opened against `main`

## Cross-references

- Reuses PR 1's engine + condition + user-state; reuses PR 2's loaders + alt-group grouping pattern; reuses PR 3's TutorialMeta branch metadata.
- PR 5 (analytics) reads the `BranchDecisions` rows that PR 2/3/4 write — the Joule tool dispatch will also write a row with `source: 'jouleTool'` (already covered in PR 2's writeBranchDecision helper if reused; this PR can extend it to include the surface=missionAltGroup or tutorialBranch + source=jouleTool).
