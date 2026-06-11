# 172 PR 4 — Joule narration tool design

> **Status:** design (spec). Implementation plan lands at `docs/superpowers/plans/2026-06-11-172-branching-pr4-joule-narration.md` next.
>
> **Predecessors:** [PR 1 design](./2026-06-09-172-branching-paths-design.md) §5.4 (full v1 vision); [PR 2 plan](../plans/2026-06-09-172-branching-pr2-mission-alt-groups.md), [PR 3 plan](../plans/2026-06-10-172-branching-pr3-tutorial-branches.md). PR 1+2+3 all merged.
>
> **Issue:** [#172](https://github.com/sap-tutorials/tutorials-ims/issues/172) — branching paths.

---

## 1. Goal

Make branch reasoning askable through Joule chat. A new chat tool `getBranchRecommendation` lets the LLM answer questions like "why is HANA Cloud recommended?" or "what's the difference between these branches?" by calling the engine directly. The existing tutorial step-help FAB seeds branch-aware starter prompts when the user is reading a tutorial with branching, so the user can ask the question with one click instead of typing context.

All behavior is gated on `ChatSettings.enabled = true && ChatSettings.branchingEnabled = true` (the master flags from PR 1 + the existing chat enablement). Prod behavior is unchanged on merge.

## 2. Scope

PR 4 ships these in one PR (per spec §9.1):

- `srv/lib/branch/joule-tool.js` — pure handler module exporting `GET_BRANCH_RECOMMENDATION_TOOL` (OpenAI-shaped tool definition) and `getBranchRecommendationHandler({ args, user })` (dispatcher logic). Composes its own engine queries; reads `BranchSpecs` (PR 3) and `Missions/CompletionPaths/CompletionPathItems` (PR 2 substrate) directly. Writes `BranchDecisions` rows with `source: 'jouleTool'`.
- `srv/lib/chat-orchestrator.js` integration — register the tool in `toolsForContext` when `branchingEnabled`, dispatch in the `name === 'getBranchRecommendation'` branch, export the tool definition.
- `srv/lib/chat-context.js` — append a `BRANCHING_GUIDANCE` line to `tutorialLayer` and `collectionLayer` when `pageContext.branchContext` (tutorial) or `pageContext.altGroupsCount > 0` (mission) is present.
- `hugo-apps/src/tutorial-branches/branch-state-bus.ts` — tiny module exporting `publishBranchState(state)` and `subscribeBranchState(handler)`. Uses CustomEvent on `document`.
- `hugo-apps/src/tutorial-branches/BranchPicker.vue` — call `publishBranchState` from `onMounted` and `onItemClick`.
- `hugo/layouts/tutorials/u1-object-page.html` — maintain `latestBranchState` Map; subscribe to events; `opGetCurrentStep` attaches `branchContext` for the current step's branch point.
- `hugo/layouts/partials/joule-starters.html` — new `tutorial-step-with-branch` kind with three branch-aware prompts.
- `hugo/public/js/joule.js` — switch starter kind based on `branchContext` presence; extend `substituteStarter` for new vars (`{currentLabel}`, `{recommendedLabel}`, `{branchLabel}`); extend `readPageContext()` to attach `branchContext`.
- Tests: ~10 unit + 1 hybrid + 6-step manual checklist in PR body.
- Docs: `docs/developers/operations/testing-endpoints.md` reference for the new tool; admin chat-settings help text on the `branchingEnabled` switch.
- `.deploy/mta.yaml` — register `joule-tool.js` in srv-qa cp list.

**Not in this PR (deferred):**

- PR 5 — author analytics tile reading `BranchDecisions.source` to break down "% of branch decisions surfaced via chat vs page load."
- PR 6 — profile fields populated end-to-end (`UserMetaData.deployment/role/cloud`). Until PR 6, profile-conditional branches always evaluate false → ranker takes over → tool returns deterministic-default for most authed users.
- Cookbook entry "Question patterns Joule answers well" — speculative until pilot LLM behavior is observed.
- i18n for the starter prompts — platform is English-only per [[project_developers_locales]].

## 3. Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Build time (no changes)                                                    │
│ Tutorial pages already carry branchPoints + skipPoints in their step       │
│ frontmatter (PR 3). BranchSpecs sidecar already populated (PR 3).          │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Runtime: page load ───────────────────────────────────────────────────────┐
│ 1. Tutorial HTML loaded from HANA blob                                     │
│ 2. BranchPicker.vue mounts on .tutorial-branch-mount markers               │
│ 3. Picker fetches /api/branches/decide → resolves recommendation           │
│ 4. Picker calls publishBranchState(...) on each state change               │
│    → fires `branch:state-change` CustomEvent on document                   │
│ 5. u1-object-page.html script captures events into latestBranchState Map   │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Runtime: user clicks Joule step-help FAB ─────────────────────────────────┐
│ 1. opGetCurrentStep() returns { slug, n, heading, branchContext }          │
│ 2. joule.js#openWithStepContext(ctx) sees branchContext → kind:            │
│    'tutorial-step-with-branch'                                             │
│ 3. renderStarters reads new kind, substitutes labels from tutorial-data    │
│    JSON                                                                    │
│ 4. User clicks a starter prompt                                            │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Runtime: chat turn with branch question ──────────────────────────────────┐
│ 1. joule.js#send POSTs /chat/stream with messages + pageContext            │
│ 2. readPageContext attaches branchContext (same Map lookup)                │
│ 3. CAP /chat/stream → streamChat({ messages, pageContext, ... })           │
│ 4. buildSystemPrompt → tutorialLayer sees branchContext → appends          │
│    BRANCHING_GUIDANCE                                                      │
│ 5. toolsForContext sees branchingEnabled → pushes GET_BRANCH_RECOMMENDATION│
│ 6. LLM calls getBranchRecommendation({ tutorialSlug, branchPointId })      │
│ 7. Tool dispatch: getBranchRecommendationHandler                           │
│    - reads BranchSpecs                                                     │
│    - calls pickBranch + evaluateSkip via PR1 engine                        │
│    - writes BranchDecisions (source: jouleTool)                            │
│    - returns { branchPoints, altGroups, skipPoints }                       │
│ 8. LLM frames the response conversationally                                │
└────────────────────────────────────────────────────────────────────────────┘
```

The whole runtime is gated on `branchingEnabled`. When false: tool not registered → LLM has no tool to call → falls back to general guidance. Pure additive, default-off.

## 4. Components

### 4.1 Tool handler (`srv/lib/branch/joule-tool.js`)

Pure module, no I/O at module top level.

**Exports:**

```javascript
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

export async function getBranchRecommendationHandler({ args, user }) { ... }
```

**Param validation (returns error in result, not throws):**

| Condition | Result |
|---|---|
| All three params absent | `{ error: 'requires_at_least_one_of: missionSlug, tutorialSlug, branchPointId' }` |
| `branchPointId` without `tutorialSlug` | `{ error: 'branchPointId requires tutorialSlug' }` |

Slugs are lowercased at handler entry (per CLAUDE.md tutorial-slug rule).

**Resolution path for tutorial scope** (`tutorialSlug` given):

1. Read `BranchSpecs` row for the slug.
2. If no row: return `{ branchPoints: [], altGroups: [], skipPoints: [], note: 'tutorial_has_no_branches' }`.
3. Parse `branchPoints` and `skipPoints` JSON columns.
4. If `branchPointId` given, filter `branchPoints` to that one. If filtered set is empty: return `{ error: 'unknown_branch_point: <id>' }`.
5. Build `userState` via `buildUserState(user, makeBranchLoaders())`.
6. For each branchPoint: call `pickBranch(branchPoint, userState, { tutorialSlug }, { rankBranches: (b, s, c) => rankBranches(b, s, c, loaders) })`. Compose result `{ id, picked, reason, confidence, allBranches: bp.branches.map(b => ({ key, label })) }`.
7. For each skipPoint: call `evaluateSkip(spec.skipIf, userState)`. Compose `{ stepNumber, skip, reason, skipLabel?, skipReason? }`.
8. Write one `BranchDecisions` row per recommendation (surface `tutorialBranch` for branch points; surface `tutorialSkip` for skipped step decisions only when `skip === true`). `source: 'jouleTool'`.
9. Return `{ branchPoints: [...], altGroups: [], skipPoints: [...] }`.

**Resolution path for mission scope** (`missionSlug` given):

1. Read `Missions` by slug. If not found: return `{ branchPoints: [], altGroups: [], skipPoints: [], note: 'mission_not_found' }`.
2. Read `CompletionPaths` for the mission.
3. For each path, read `CompletionPathItems` ordered by `itemOrder`.
4. Group items by `(itemOrder, altGroupKey)` — same logic as `mission-detail.js` and `build-catalog.js`.
5. For each alt-group: build `branchPoint` shape (id `${parentStepNumber}-${altGroupKey}`, surface `missionAltGroup`, branches per item with `key = slugifyKey(altGroupLabel)`), call `pickBranch`.
6. Write `BranchDecisions` rows, `surface: 'missionAltGroup'`, `source: 'jouleTool'`.
7. Return `{ branchPoints: [], altGroups: [...], skipPoints: [] }`.

**Combined scope** (both `tutorialSlug` and `missionSlug` given): run both paths, merge results.

**Telemetry write helper:** factored from `decide.js`'s pattern. Per follow-up #296, telemetry is uniformly written from chat (no `?nocache=1` analog — the user typing in chat IS the user-action surface). Best-effort try/catch; warn on failure but don't fail the tool result.

### 4.2 Chat orchestrator integration (`srv/lib/chat-orchestrator.js`)

**Tool registration** in `toolsForContext({ pageContext, isAdmin })`. After the existing `if (settings?.codeCheckEnabled)` block, add:

```javascript
if (settings?.branchingEnabled) {
  tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
}
```

**Tool dispatch** alongside the existing `name === 'getRelevantSteps'` block:

```javascript
if (name === 'getBranchRecommendation') {
  return await getBranchRecommendationHandler({ args, user });
}
```

**Imports** at the top of the file:

```javascript
import { GET_BRANCH_RECOMMENDATION_TOOL, getBranchRecommendationHandler } from './branch/joule-tool.js';
```

**Export** in the existing export list at line 598.

**Citation handling** (around line 557): NOT needed. The LLM frames the prose; structured cites like "[tutorial-slug #stepNumber]" used by `getRelevantSteps` don't apply here.

### 4.3 System prompt guidance (`srv/lib/chat-context.js`)

New constant, mirroring `RAG_GUIDANCE`:

```javascript
const BRANCHING_GUIDANCE = "When the user asks about branch choices, recommendations, or 'why this branch', call `getBranchRecommendation` rather than guessing — it returns the engine's recommendation with reason. Cite the recommended branch's label (not its key).";
```

Append in `tutorialLayer(ctx)` when `ctx.branchContext` is present:

```javascript
if (ctx.branchContext) {
  lines.push(BRANCHING_GUIDANCE);
}
```

Append in `collectionLayer(ctx, kindLabel)` when `ctx.altGroupsCount > 0`:

```javascript
if (ctx.altGroupsCount > 0) {
  lines.push(BRANCHING_GUIDANCE);
}
```

Both fields come from `readPageContext()` (frontend) — see §4.6.

### 4.4 Cross-component state bus (`hugo-apps/src/tutorial-branches/branch-state-bus.ts`)

Tiny module, ≤30 LOC.

```typescript
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

The subscribe path is unused by the island itself — it's exported for the page-level reader script in u1-object-page.html. Vite tree-shakes `subscribeBranchState` from the island bundle.

### 4.5 BranchPicker.vue updates

In `BranchPicker.vue`:

1. Import `publishBranchState` from `./branch-state-bus.js`.
2. After the `recommendedKey.value = ...` line in `onMounted` (at the end of the recommendation-adopt block), call:
   ```typescript
   publishBranchState({
     branchPointId: props.branchPointId,
     groupKey: props.groupKey,
     currentBranch: selectedKey.value,
     recommendedBranch: recommendedKey.value,
   });
   ```
3. After `localStorage.setItem(...)` in `onItemClick`, call the same thing.

The publish is a fire-and-forget side effect — never throws.

### 4.6 Page-level reader (`hugo/layouts/tutorials/u1-object-page.html`)

Replace the existing `window.opGetCurrentStep` block (lines 695–700) with:

```html
<script>
  // [#172 PR 4] Branch state bus reader. The Vue island fires
  // `branch:state-change` CustomEvents whenever a BranchPicker's selected
  // or recommended branch changes; we maintain the latest state per
  // branchPointId in this Map for opGetCurrentStep + readPageContext.
  const latestBranchState = new Map();
  document.addEventListener('branch:state-change', (e) => {
    if (e.detail?.branchPointId) {
      latestBranchState.set(e.detail.branchPointId, e.detail);
    }
  });

  function getCurrentStepBranchContext(stepNum) {
    const stepEl = document.getElementById('step-' + stepNum);
    if (!stepEl) return null;
    const mount = stepEl.querySelector('.tutorial-branch-mount[data-branch-point-id]');
    if (!mount) return null;
    return latestBranchState.get(mount.dataset.branchPointId) || null;
  }

  // Expose step-context getter for the Joule step-help FAB. Returns
  // {slug, n, heading, branchContext?} for the step closest to viewport
  // center, or step 1.
  window.opGetCurrentStep = function () {
    const n = getCurrentStep();
    const stepEl = document.getElementById('step-' + n);
    const heading = stepEl?.querySelector('.step-title-text')?.textContent?.trim() || '';
    const ctx = { slug: tutorialSlug, n, heading };
    const branchContext = getCurrentStepBranchContext(n);
    if (branchContext) ctx.branchContext = branchContext;
    return ctx;
  };

  // Expose for joule.js#readPageContext.
  window.opGetCurrentStepBranchContext = getCurrentStepBranchContext;
</script>
```

### 4.7 Starter prompts (`hugo/layouts/partials/joule-starters.html`)

Add a new top-level key `tutorial-step-with-branch`:

```json
"tutorial-step-with-branch": [
  "Why is {recommendedLabel} recommended for me here?",
  "What's the difference between {currentLabel} and {recommendedLabel}?",
  "Should I switch from {currentLabel} to {recommendedLabel}?"
]
```

When `currentBranch === recommendedBranch`, the differential prompts read awkwardly ("Should I switch from HANA to HANA?"). The substitution layer suppresses them in this case (see §4.8).

### 4.8 joule.js extensions

**`openWithStepContext(ctx)`** — when `ctx.branchContext` is present, switch starterContext kind from `'tutorial-step'` to `'tutorial-step-with-branch'`:

```javascript
openWithStepContext(ctx) {
  const kind = ctx?.branchContext ? 'tutorial-step-with-branch' : 'tutorial-step';
  const opts = { starterContext: { kind, vars: ctx || {} } };
  if (!this._ready) { this._pendingOpen = opts; return; }
  _openImpl(opts);
},
```

**`substituteStarter(text, vars)`** — extend with three new substitutions. Lookup the labels by joining `vars.branchContext.{currentBranch,recommendedBranch,groupKey}` against the page's `tutorial-data` JSON:

```javascript
function substituteStarter(text, vars) {
  let out = text;
  // ...existing substitutions for {n}, {heading} unchanged...

  // [#172 PR 4] Branch label substitutions. Lookup via tutorial-data JSON.
  if (vars?.branchContext) {
    const labels = lookupBranchLabels(vars.branchContext);
    out = out.replace(/\{currentLabel\}/g, labels.currentLabel ?? '');
    out = out.replace(/\{recommendedLabel\}/g, labels.recommendedLabel ?? '');
    out = out.replace(/\{branchLabel\}/g, labels.recommendedLabel ?? labels.currentLabel ?? '');
  } else {
    // No branch context — strip the placeholders cleanly.
    out = out.replace(/\{currentLabel\}|\{recommendedLabel\}|\{branchLabel\}/g, '');
  }
  return out;
}

function lookupBranchLabels(branchContext) {
  try {
    const dataEl = document.getElementById('tutorial-data');
    if (!dataEl) return {};
    const steps = JSON.parse(dataEl.textContent || '[]');
    for (const step of steps) {
      if (step.branchPointId !== branchContext.branchPointId) continue;
      const branches = step.branches || [];
      const current = branches.find(b => b.key === branchContext.currentBranch);
      const recommended = branches.find(b => b.key === branchContext.recommendedBranch);
      return {
        currentLabel: current?.label ?? null,
        recommendedLabel: recommended?.label ?? null,
      };
    }
  } catch { /* ignore */ }
  return {};
}
```

**Differential prompt suppression** in `renderStarters`: when both labels resolve and they're equal, skip prompts containing both `{currentLabel}` and `{recommendedLabel}` (the differential ones). Keep the "Why is X recommended" prompt:

```javascript
function renderStarters(starterCtx) {
  const starters = loadStarters();
  let list;
  // ...existing kind selection logic...

  // [#172 PR 4] When current === recommended, drop the differential prompts.
  const vars = starterCtx?.vars;
  if (vars?.branchContext && vars.branchContext.currentBranch === vars.branchContext.recommendedBranch) {
    list = list.filter(t => !(t.includes('{currentLabel}') && t.includes('{recommendedLabel}')));
  }

  // ...existing rendering loop...
}
```

**`readPageContext()`** — extend the `ctx.kind === 'tutorial'` block to attach `branchContext`:

```javascript
if (ctx.kind === 'tutorial') {
  // ...existing currentStep / expandedSteps / currentStepText logic...

  // [#172 PR 4] Attach branchContext for the current step so the chat
  // orchestrator's tutorialLayer can append BRANCHING_GUIDANCE.
  if (ctx.currentStep && typeof window.opGetCurrentStepBranchContext === 'function') {
    const bc = window.opGetCurrentStepBranchContext(ctx.currentStep);
    if (bc) ctx.branchContext = bc;
  }
}
```

For mission/group pages (collectionLayer): the `<html>` tag in `hugo/layouts/_default/baseof.html` already emits `data-page-kind` / `data-page-slug`. PR 4 adds one attribute alongside: `data-altgroups-count="{{ len .Params.altGroups | default 0 }}"` (or equivalent — the mission frontmatter already carries `altGroups[]` from PR 2). `readPageContext` reads it:

```javascript
if (ctx.kind === 'mission' || ctx.kind === 'group') {
  const n = Number(html.dataset.altgroupsCount || '0');
  if (n > 0) ctx.altGroupsCount = n;
}
```

## 5. Data flow (worked example)

See brainstorm conversation Section 3 (committed verbatim into the plan during writing-plans). Covers: page load + island state publish; FAB click + starter selection; chat turn end-to-end including tool dispatch + telemetry write; flag-off behavior; mission-scope query; stale-state edge case.

## 6. Edge cases

- **Tool called with no params** → `{ error: 'requires_at_least_one_of: ...' }`. LLM apologizes or asks user.
- **branchPointId without tutorialSlug** → `{ error: 'branchPointId requires tutorialSlug' }`.
- **Tutorial has no branches** → `{ branchPoints: [], altGroups: [], skipPoints: [], note: 'tutorial_has_no_branches' }`.
- **Mission has no alt-groups** → `{ branchPoints: [], altGroups: [], skipPoints: [], note: 'mission_has_no_alt_groups' }`.
- **branchPointId doesn't match any in tutorial** → `{ error: 'unknown_branch_point: <id>' }`.
- **Anonymous user** → `buildUserState(null, ...)` returns empty state. Engine deterministic-default. Tool returns the data; LLM frames as "the default option" rather than "personalized for you."
- **Engine throws** (shouldn't, per PR 1 contract) → wrap each `pickBranch`/`evaluateSkip` in try/catch, degrade to deterministic-default in the response, log warn.
- **BranchDecisions write failure** → log warn, swallow. Tool result still returned.
- **branchContext stale after step navigation** → `latestBranchState` Map keyed by branchPointId; `opGetCurrentStep` reads only the entry matching the current step's branch point.
- **User opens FAB before BranchPicker mounts** → Map empty for that branchPointId; `branchContext` field omitted; falls back to `tutorial-step` kind without branch starters.
- **User toggles branches rapidly** → multiple events, only last one is read at FAB-click time.
- **branchingEnabled flipped mid-session** → next chat turn re-reads in `toolsForContext`; tool list updates accordingly; existing chat history unaffected.
- **currentBranch === recommendedBranch** → differential prompts suppressed; "Why is X recommended" still renders.
- **Multiple branch points on one tutorial** → each fires its own `branch:state-change`; Map indexed by branchPointId; correct entry retrieved per step.
- **Chat tool called for tutorial with one branchPoint, one skipPoint, no condition matching** → returns both arrays populated; LLM can answer either flavor of question.

## 7. Testing

- **Unit (~7 tests)** in `test/branch-joule-tool.test.js`:
  1. Param validation: no params → error string.
  2. Param validation: branchPointId without tutorialSlug → error string.
  3. Tutorial scope, anonymous → returns deterministic-default.
  4. Tutorial scope, authed-with-condition (mock loadProfile to satisfy condition) → returns reason.kind === 'condition'. Verify BranchDecisions row written with source='jouleTool'.
  5. branchPointId scoping → returns only the matching branchPoint.
  6. Mission scope → returns altGroups[] populated, recommendation per alt-group.
  7. Tutorial with no branches → returns empty arrays + note.

- **Chat orchestrator integration** in `test/chat-orchestrator-tools.test.js` (or extend existing): 2 cases verifying `toolsForContext` registration with flag on/off.

- **FAB / starter substitution** in `test/joule-branch-starters.test.js`: 2-3 cases on `substituteStarter` with branch vars + the suppress-differential-when-equal edge case.

- **Hybrid (1 test, gated)** in `test/hybrid/branch-joule-tool.test.js`: real HANA round-trip on the tool handler. Seeds `__test__` BranchSpecs row, calls handler, verifies returned shape + `BranchDecisions` write succeeds against real schema. Catches HANA SQL drift in JSON column reads. Gated on `ALLOW_HYBRID_WRITES=true`.

- **Smoke** — skip. No new public route shape; the `/chat/stream` endpoint smoke would require LLM round-trip which is out of scope.

- **Manual checklist** (in PR body, for Tom + pilot author) covers: seeded fixture verification, branch-aware starter rendering, LLM response cite verification, switch-branch starter, mission-scope query, flag-off fallback.

**Total:** ~10-12 unit + 1 hybrid + 6-step manual checklist.

## 8. Default-off behavior

`ChatSettings.branchingEnabled = false` (default):

- `toolsForContext` skips registering `getBranchRecommendation` → LLM has no tool to call.
- `tutorialLayer` still appends `BRANCHING_GUIDANCE` whenever `branchContext` is in the page context. With no tool registered, the LLM can't act on the guidance — it falls back to general guidance and either guesses, asks the user, or skips the topic. The guidance line is harmless extra text in the system prompt; we don't conditionally suppress it based on tool registration to keep the prompt-builder ignorant of orchestrator state.
- Joule starter selection ignores `branchContext` (the kind is `'tutorial-step-with-branch'` in joule-starters.html, but the FAB still passes the kind through; the LLM just doesn't have a branch tool, so the answer falls back to general guidance).
- BranchPicker continues to publish `branch:state-change` events (lightweight, no flag check needed in the island).
- `BranchDecisions` rows from page-load decisions (PR 3's `decide.js`) still written; chat-source rows just never written.

PR 4 ships default-off. Prod is unchanged on merge. Flag flip happens in DEV/QA after PR 6 ships profile fields + the pilot mission is seeded.

## 9. Risks

| Risk | Mitigation |
|---|---|
| LLM hallucinates a recommendation different from the tool's output | Tool returns explicit `picked`, `reason.kind`, `reason.source`, `allBranches`. Tool description says "return which branch is recommended" — not "decide which is best." Pilot validation catches drift. |
| Tool called when no branching exists on the page | `note: 'tutorial_has_no_branches'` / `mission_has_no_alt_groups` strings. LLM gracefully tells user. |
| Multiple tool calls per chat turn | BranchDecisions writes per call; volume bounded by chat rate limits. Acceptable v1 cost. |
| `branchContext` stale after step navigation | Map keyed by branchPointId; `opGetCurrentStep` reads only matching entry. Stale entries inert. |
| Anonymous users get bland recommendations until PR 6 ships profile fields | Documented in v1 limitations. LLM frames default as "the default option" rather than "personalized." |
| `srv-qa` cp list misses `joule-tool.js` | PR checklist line per [[feedback_srv_qa_cp_list_recurring]]; verified in cp-list task. |
| Vue island chunk grows past 12 KB budget | `branch-state-bus.ts` ≤30 LOC; subscribe path tree-shaken from island bundle. Negligible impact (current 2.86 KB; expected ~3.0 KB). |
| Hybrid test pollutes BranchDecisions in DEV | Test seeds `__test__` slugs; cleanup in afterAll. |
| LLM calls tool excessively | Chat rate limits + the explicit "Use this when…" tool description constrain. |

## 10. Definition of done

- All tasks merged to main behind `branchingEnabled = false` (no prod behavior change).
- ~10-12 unit tests + 1 hybrid green.
- `docs/developers/operations/testing-endpoints.md` documents the new tool: params, return shape, registration gate, telemetry behavior.
- Admin chat-settings tile help text on the `branchingEnabled` switch (one-line description).
- `.deploy/mta.yaml` srv-qa cp list updated and verified (`srv/lib/branch/joule-tool.js`).
- Vue island chunk budget guard still passes (`tutorial-branches.js` ≤ 12 KB gzipped).
- Joule FAB on a seeded fixture mission visibly renders branch-aware starters when both flags are on (visual confirmation in DEV — manual checklist).

After PR 4:

- PR 5 — author analytics tile (per-mission branch performance; reads `BranchDecisions.source`).
- PR 6 — profile fields populated end-to-end + pilot enablement (gates the actual flag flip).

## 11. Cross-references

- Spec: [docs/superpowers/specs/2026-06-09-172-branching-paths-design.md](2026-06-09-172-branching-paths-design.md) §5.4 — Joule narration vision.
- PR 3 plan: [docs/superpowers/plans/2026-06-10-172-branching-pr3-tutorial-branches.md](../plans/2026-06-10-172-branching-pr3-tutorial-branches.md) — substrate this PR uses (`BranchSpecs`, decide.js, BranchPicker.vue, opGetCurrentStep).
- PR 2 plan: [docs/superpowers/plans/2026-06-09-172-branching-pr2-mission-alt-groups.md](../plans/2026-06-09-172-branching-pr2-mission-alt-groups.md) — `mission-detail.js` substrate this PR partially mirrors (mission scope query path).
- PR 1 (engine + condition language + telemetry): merged before PR 2.
- Existing chat tool patterns (mounting reference): `srv/lib/chat-orchestrator.js`'s `getRelevantSteps` and `checkCode` tools.
- Existing FAB pattern: [project_joule_step_help_shipped]] (from memory).
- Closes follow-up PR work: none — PR 4 is purely additive on top of PR 3.
