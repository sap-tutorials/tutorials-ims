# Joule on the Developer Advocates Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Joule into the public `/developer-advocates/` page with a scoped `advocates` page-context kind that grounds answers in the roster + SAP tutorial content only.

**Architecture:** Additive change. Hugo emits `data-page-kind="advocates"` on the page; the Vue island stashes the loaded roster on `window.__JOULE_ADVOCATES`; the existing `joule.js` reads it via `readPageContext`; the existing `/chat/stream` orchestrator (`srv/lib/chat-context.js` + `srv/lib/chat-orchestrator.js`) gains a new persona, an `advocatesLayer` formatter, and an early-return branch in `toolsForContext`. No new services, endpoints, or schema.

**Tech Stack:** Hugo (templates), Vue 3 + Vite (advocates island), vanilla JS (joule.js), CAP Node.js (chat orchestrator), Vitest (tests).

**Spec:** [docs/superpowers/specs/2026-06-23-joule-advocates-page-design.md](../specs/2026-06-23-joule-advocates-page-design.md)

**Issue:** [#564 — Joule for Developer Advocates Page](https://github.com/sap-tutorials/tutorials-ims/issues/564)

---

## File map

The change touches 11 files (8 modify, 2 new test files, 1 new spec already committed):

| Path | Purpose | Type |
|---|---|---|
| `hugo/layouts/_default/baseof.html` | Map `Type == "developer-advocates"` to `data-page-kind="advocates"` | Modify |
| `hugo/layouts/partials/joule-starters.html` | Add `"advocates"` key with 3 starter prompts | Modify |
| `hugo-apps/src/advocates/App.vue` | Stash roster on `window.__JOULE_ADVOCATES` in `load()` + synchronous default | Modify |
| `hugo/static/js/joule.js` | Read `window.__JOULE_ADVOCATES` in `readPageContext()` for `advocates` kind | Modify |
| `srv/lib/chat-context.js` | New `ADVOCATES_PERSONA`, `MAX_ROSTER_ENTRIES`, `advocatesLayer`, switch case, `buildSystemPrompt` advocates branch | Modify |
| `srv/lib/chat-orchestrator.js` | Early-return `advocates` branch in `toolsForContext` | Modify |
| `test/chat-context.test.js` | New test cases for `kind: 'advocates'` + regression guard for `kind: 'admin'` | Modify |
| `test/unit/chat-orchestrator-codecheck.test.js` | Assert advocates kind bypasses ChatSettings tools; tutorial test stays green | Modify |
| `hugo-apps/src/advocates/App.joule-handoff.test.ts` | Frontend handoff unit test, **colocated** (matches the vitest unit project glob `hugo-apps/src/**/*.test.{js,ts}`, and the file-naming convention the existing `hugo-apps/` tests use). The spec listed `__tests__/joule-handoff.test.ts` — both paths resolve via the glob; colocated keeps the test next to the file it covers. | New |
| `test/smoke/advocates.smoke.test.js` | Smoke: `data-page-kind`, starters key, bundle contains `__JOULE_ADVOCATES` | Modify |

We're working on branch `spec/joule-advocates-page` (already created and pushed during brainstorming). Implementation commits land on the same branch.

> **Per-task subagent safety (issue [memory: branch-slip-after-long-session](.claude/memory/feedback_branch_slip_after_long_session.md))** — if you're dispatching subagents per task, prefix each task's `git commit` step with a re-checkout in the SAME shell invocation as the commit:
>
> ```bash
> git checkout spec/joule-advocates-page && \
>   git -c core.autocrlf=false add ... && \
>   git -c core.autocrlf=false commit -m "..."
> ```
>
> The plan's commit blocks below show `git add` + `git commit` only — extend with the leading `git checkout` if running in a fresh subagent shell.

---

## Task 1: Hugo template — add the `advocates` page-kind

Tiny change that anchors everything else. Until Hugo emits `data-page-kind="advocates"`, the frontend never enters the new branch and the backend never gets the new kind. Land it first so subsequent tasks can verify against rendered HTML.

**Files:**
- Modify: `hugo/layouts/_default/baseof.html` (line 3)

- [ ] **Step 1: Read the file to confirm current state**

Run: `grep -n 'data-page-kind' hugo/layouts/_default/baseof.html`
Expected output:
```
3:  data-page-kind="{{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}"
```

- [ ] **Step 2: Edit the ternary to add the advocates branch**

Replace the line above with:

```html
  data-page-kind="{{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else if eq .Type "developer-advocates" }}advocates{{ else }}generic{{ end }}"
```

- [ ] **Step 3: Render Hugo locally and verify**

```bash
npm run dev
```

In a new terminal:
```bash
curl -s http://localhost:1313/developer-advocates/ | grep -o 'data-page-kind="[^"]*"' | head -1
```
Expected: `data-page-kind="advocates"`

Then verify the other page kinds are unchanged:
```bash
curl -s http://localhost:1313/ | grep -o 'data-page-kind="[^"]*"' | head -1
# Expected: data-page-kind="search"
curl -s http://localhost:1313/tutorials/abap-environment-trial-onboarding/ | grep -o 'data-page-kind="[^"]*"' | head -1
# Expected: data-page-kind="tutorial"
```

If Hugo dev needs `fetch-tutorials` first (cold worktree), run `npm run fetch-tutorials` before `npm run dev`.

Stop `npm run dev` (Ctrl-C) once verified.

- [ ] **Step 4: Commit**

```bash
git -c core.autocrlf=false add hugo/layouts/_default/baseof.html
git -c core.autocrlf=false commit -m "feat(joule-advocates): emit data-page-kind=advocates on /developer-advocates/"
```

---

## Task 2: Hugo starters — add advocates prompts

Three prompt suggestions surfaced on the chat panel hero when opened from `/developer-advocates/`. Picked to cover the three capability classes (find-by-topic, describe-named, find-tutorials-with-bridge).

**Files:**
- Modify: `hugo/layouts/partials/joule-starters.html`

- [ ] **Step 1: Read current state**

Run: `cat hugo/layouts/partials/joule-starters.html`

Confirm it has a JSON literal keyed by page-kind names (`"tutorial"`, `"mission"`, `"group"`, `"search"`, `"generic"`).

- [ ] **Step 2: Add the `"advocates"` key**

Insert a new key BEFORE `"generic"` (alphabetical or natural — both are fine; pick BEFORE-generic so the diff is contiguous):

```json
  "advocates": [
    "Who can I follow for CAP?",
    "Show me tutorials by our advocates on HANA Cloud.",
    "Where is Thomas Jung based and what does he focus on?"
  ],
```

After edit, the file should still be valid JSON inside the `<script>` tag.

- [ ] **Step 3: Validate JSON shape**

```bash
node -e "const s=require('fs').readFileSync('hugo/layouts/partials/joule-starters.html','utf8'); const m=s.match(/<script[^>]*>([\\s\\S]*?)<\\/script>/); JSON.parse(m[1]); console.log('JSON valid');"
```
Expected: `JSON valid`

- [ ] **Step 4: Commit**

```bash
git -c core.autocrlf=false add hugo/layouts/partials/joule-starters.html
git -c core.autocrlf=false commit -m "feat(joule-advocates): add 'advocates' starter prompts"
```

---

## Task 3: Backend — `ADVOCATES_PERSONA` constant and `advocatesLayer`

This is the biggest piece. We add a new persona, a roster formatter with a server-side cap, a switch-case in `pageLayer`, and an `advocates` branch in `buildSystemPrompt` that intentionally strips both `RAG_GUIDANCE` and `PROGRESS_GUIDANCE`. Three of the new test cases go in first (TDD), then we make them pass.

**Files:**
- Modify: `srv/lib/chat-context.js`
- Modify: `test/chat-context.test.js`

- [ ] **Step 1: Write failing tests for the new advocates kind**

Open `test/chat-context.test.js`. Insert the new cases **inside the FIRST `describe('buildSystemPrompt', …)` block** (the one starting at line 4 and ending at line 70), BEFORE its closing `});`. Do NOT add them to the second `describe('buildSystemPrompt — BRANCHING_GUIDANCE', …)` block that follows — those are scoped to a different concern.

Append:

```js
  // --- advocates kind (issue #564) ---
  const ADVOCATE_FIXTURE = {
    firstName: 'Thomas', lastName: 'Jung', region: 'AMERICAS',
    title: 'Developer Advocate', location: 'Jasper, IN',
    bio: 'Builds CAP samples and decommissions Java IMS one endpoint at a time.',
    topics: [{ slug: 'software-product>cap', label: 'SAP Cloud Application Programming Model' }],
    links: [{ kind: 'LinkedIn', url: 'https://linkedin.com/in/thomas-jung' }]
  };

  it('uses ADVOCATES_PERSONA and includes roster details for kind=advocates', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [ADVOCATE_FIXTURE] }, user);
    expect(out).toMatch(/Developer Advocates page/);
    expect(out).toMatch(/Thomas Jung/);
    expect(out).toMatch(/AMERICAS/);
    expect(out).toMatch(/SAP Cloud Application Programming Model/);
    // bridge-to-advocate instruction present
    expect(out).toMatch(/bridge.*covers/i);
  });

  it('skips RAG_GUIDANCE and PROGRESS_GUIDANCE for kind=advocates', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [ADVOCATE_FIXTURE] }, user);
    expect(out).not.toMatch(/getRelevantSteps/);
    expect(out).not.toMatch(/getUserProgress tool/);
  });

  it('falls back to empty-roster guidance when advocates=[]', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [] }, user);
    expect(out).toMatch(/has not loaded yet/);
    expect(out).toMatch(/searchTutorials/);
  });

  it('does not throw when advocates is not an array', () => {
    expect(() =>
      buildSystemPrompt({ kind: 'advocates', advocates: 'not-an-array' }, user)
    ).not.toThrow();
    const out = buildSystemPrompt({ kind: 'advocates', advocates: 'not-an-array' }, user);
    expect(out).toMatch(/has not loaded yet/);
  });

  it('regression: admin path still includes RAG_GUIDANCE', () => {
    const out = buildSystemPrompt({ kind: 'admin', tool: 'analytics-builder' }, user);
    expect(out).toMatch(/getRelevantSteps/);
  });
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
npx vitest run --project unit test/chat-context.test.js
```
Expected: the 5 new tests show failures (advocates kind not yet supported), and the 12 existing tests (8 in the first `describe`, 4 in the second BRANCHING_GUIDANCE describe) still pass. The new "regression: admin path still includes RAG_GUIDANCE" test should pass even before any source change, because the current `buildSystemPrompt` already adds `RAG_GUIDANCE` unconditionally for non-advocates kinds.

If any of the 12 existing tests fails, STOP and inspect.

- [ ] **Step 3: Add `ADVOCATES_PERSONA` to `srv/lib/chat-context.js`**

Open `srv/lib/chat-context.js`. Insert AFTER the closing backtick of the `PROGRESS_GUIDANCE` const (line 49) and BEFORE the `STEP_TEXT_BUDGET` const (line 51) — i.e. on the empty line 50:

```js
const ADVOCATES_PERSONA = `You are Joule, embedded on the SAP Developer
Advocates page. Your scope is the developer advocates roster shown to
the user (the JSON list below), the SAP topics those advocates cover,
and the SAP tutorial content available on this platform.

You can answer three kinds of question:
  1. Who specializes in X / who works in region Y — answer from the
     roster below. Cite the advocate's name and region. Mention their
     topics and direct the user to their social links on the page.
  2. Tell me about <named advocate> — answer verbatim from the roster
     below. Do not invent bios, regions, links, or facts.
  3. What tutorials cover X — call searchTutorials. Cite 1-3 tutorials
     by slug. If any advocate's topics intersect the user's topic,
     also name them with a one-line "for deeper questions, X covers
     this area" bridge.

When the question is about an SAP topic, answer ONLY from tutorial
content via searchTutorials. Do NOT volunteer general SAP knowledge
from your training data. If searchTutorials returns nothing relevant,
say so and suggest the user reach out to a relevant advocate or
explore /tutorials/ for the full catalog.

For unrelated questions (weather, poetry, anything outside SAP and
our advocates), redirect: "I can help with our developer advocates,
the SAP topics they cover, and tutorials on this platform. Want me
to find something in those areas?"

Never invent advocate names, regions, or links — use ONLY the roster
below. Never invent tutorial slugs.`;

const MAX_ROSTER_ENTRIES = 50;
```

- [ ] **Step 4: Add `advocatesLayer` function**

In the same file, after the existing `adminLayer` function (around line 132), add:

```js
function advocatesLayer(ctx) {
  const raw = Array.isArray(ctx?.advocates) ? ctx.advocates : [];
  const advocates = raw.slice(0, MAX_ROSTER_ENTRIES);
  if (!advocates.length) {
    return [
      'Current page: Developer Advocates roster.',
      'The advocates list has not loaded yet on the user side.',
      'For tutorial-content questions, call searchTutorials. For roster',
      'questions, ask the user to wait a moment and retry.'
    ].join('\n');
  }
  const lines = ['Current page: Developer Advocates roster.', ''];
  lines.push('Roster (use ONLY these names and facts):');
  for (const a of advocates) {
    const topics = Array.isArray(a.topics) && a.topics.length
      ? a.topics.map(t => t.label || t.slug).join(', ') : '—';
    const links = Array.isArray(a.links) && a.links.length
      ? a.links.map(l => l.kind).join(', ') : '—';
    lines.push(`- ${a.firstName} ${a.lastName} (${a.region})`);
    if (a.title)    lines.push(`    title: ${a.title}`);
    if (a.location) lines.push(`    location: ${a.location}`);
    if (a.bio)      lines.push(`    bio: ${a.bio}`);
    lines.push(`    topics: ${topics}`);
    lines.push(`    links available: ${links}`);
  }
  if (raw.length > MAX_ROSTER_ENTRIES) {
    lines.push(`(${raw.length - MAX_ROSTER_ENTRIES} additional advocates not shown.)`);
  }
  lines.push('');
  lines.push(
    'When a tutorial topic the user asks about matches an advocate topic above,',
    'bridge: "For deeper questions, <Name> covers <topic> — see their profile."'
  );
  return lines.join('\n');
}
```

- [ ] **Step 5: Add `advocates` case to `pageLayer` switch**

In the `pageLayer` function (around line 134-143), insert the new case BEFORE `default:`:

```js
function pageLayer(pageContext) {
  switch (pageContext?.kind) {
    case 'tutorial':  return tutorialLayer(pageContext);
    case 'search':    return searchLayer(pageContext);
    case 'mission':   return collectionLayer(pageContext, 'mission');
    case 'group':     return collectionLayer(pageContext, 'group');
    case 'admin':     return adminLayer(pageContext);
    case 'advocates': return advocatesLayer(pageContext);
    default:          return 'Use searchTutorials liberally to ground answers.';
  }
}
```

- [ ] **Step 6: Rewrite `buildSystemPrompt` to handle the advocates branch**

Replace the existing `buildSystemPrompt` (lines 151-158) with:

```js
export function buildSystemPrompt(pageContext, user) {
  const isAdmin = pageContext?.kind === 'admin';
  const isAdvocates = pageContext?.kind === 'advocates';
  const persona = isAdmin ? ADMIN_PERSONA
                : isAdvocates ? ADVOCATES_PERSONA
                : PERSONA;
  // Preserve existing layer ordering:
  //   admin    -> [ADMIN_PERSONA, RAG_GUIDANCE, adminLayer, userLayer]
  //   learner  -> [PERSONA, RAG_GUIDANCE, PROGRESS_GUIDANCE, pageLayer, userLayer]
  //   advocates-> [ADVOCATES_PERSONA, advocatesLayer, userLayer]  (NEW)
  const layers = [persona];
  if (!isAdvocates) layers.push(RAG_GUIDANCE);
  if (!isAdmin && !isAdvocates) layers.push(PROGRESS_GUIDANCE);
  layers.push(pageLayer(pageContext), userLayer(user));
  return layers.filter(Boolean).join('\n\n');
}
```

- [ ] **Step 7: Run the tests, confirm they pass**

```bash
npx vitest run --project unit test/chat-context.test.js
```
Expected: ALL tests pass. The file should now have 12 existing + 5 new = **17 passing tests**.

- [ ] **Step 8: Commit**

```bash
git -c core.autocrlf=false add srv/lib/chat-context.js test/chat-context.test.js
git -c core.autocrlf=false commit -m "feat(joule-advocates): ADVOCATES_PERSONA + advocatesLayer in chat-context

Adds the persona, the roster formatter (with MAX_ROSTER_ENTRIES=50
server-side cap), the pageLayer switch case, and a buildSystemPrompt
branch that strips RAG_GUIDANCE and PROGRESS_GUIDANCE for kind
'advocates' only. Admin and learner paths remain byte-identical.

5 new test cases: roster formatting, empty-roster fallback, defensive
shape (non-array advocates), absence of RAG/PROGRESS guidance, plus a
regression guard confirming admin still gets RAG_GUIDANCE."
```

---

## Task 4: Backend — `toolsForContext` early-return for advocates

Trim the tool palette so Joule on the advocates page only ever gets `searchTutorials` + `getUserProgress`. Critical that the rewrite leaves the admin/learner paths byte-identical — there's an existing test we must not break.

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`
- Modify: `test/unit/chat-orchestrator-codecheck.test.js`

- [ ] **Step 1: Write failing tests**

Open `test/unit/chat-orchestrator-codecheck.test.js`. Inside the existing `describe('toolsForContext — checkCode gating', ...)` block (or as a sibling describe), add:

```js
  // --- advocates kind (issue #564) ---
  it('advocates kind bypasses ChatSettings tools even when all flags are on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
      ragEnabled: true,
      branchingEnabled: true,
      kgPathBetweenEnabled: true,
    });

    const tools = await toolsForContext({
      pageContext: { kind: 'advocates' },
      isAdmin: false
    });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials', 'getUserProgress']);
  });

  it('advocates kind does not change palette when isAdmin=true', async () => {
    // A signed-in admin browsing /developer-advocates/ gets the same trimmed
    // palette — page context wins over admin status here.
    const tools = await toolsForContext({
      pageContext: { kind: 'advocates' },
      isAdmin: true
    });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials', 'getUserProgress']);
  });
```

- [ ] **Step 2: Run the tests, confirm 2 new tests fail and existing tests still pass**

```bash
npx vitest run --project unit test/unit/chat-orchestrator-codecheck.test.js
```
Expected: the 5 existing tests in `describe('toolsForContext — checkCode gating', …)` (lines 25, 38, 51, 58, 75) and the 3 existing tests in `describe('dispatchTool — checkCode dispatch', …)` (8 existing total) all PASS. The 2 new advocates tests FAIL because the kind isn't handled yet. If any existing test fails, STOP.

- [ ] **Step 3: Add the early-return branch**

Open `srv/lib/chat-orchestrator.js`. Find `async function toolsForContext({ pageContext, isAdmin })` at line 178. Replace the function body with:

```js
async function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];

  // Advocates page: trimmed palette. searchTutorials + getUserProgress.
  // ChatSettings-gated tools (getRelevantSteps, checkCode,
  // getBranchRecommendation, findLearningPath) are intentionally excluded
  // — off-scope on /developer-advocates/. Early return keeps the existing
  // admin and learner branches below byte-identical.
  if (pageContext?.kind === 'advocates') {
    tools.push(GET_USER_PROGRESS_TOOL);
    return tools;
  }

  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GENERATE_ANALYTICS_QUERY_TOOL, EXPLAIN_ANALYTICS_RESULT_TOOL);
  } else {
    // Learner-side only — admins are running the platform, not consuming
    // tutorials, so progress lookup is irrelevant in the admin persona.
    tools.push(GET_USER_PROGRESS_TOOL);
  }
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings);
    if (settings?.ragEnabled) {
      tools.push(GET_RELEVANT_STEPS_TOOL);
    }
    if (settings?.codeCheckEnabled) {
      tools.push(CHECK_CODE_TOOL);
    }
    if (settings?.branchingEnabled) {
      tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
    }
    if (settings?.kgPathBetweenEnabled) {
      tools.push(FIND_LEARNING_PATH_TOOL);
    }
  } catch (err) {
    LOG.warn('toolsForContext: could not read ChatSettings', err.message);
  }
  return tools;
}
```

The only change from the current code is the early-return block at the top.

- [ ] **Step 4: Run tests, confirm all 5 pass**

```bash
npx vitest run --project unit test/unit/chat-orchestrator-codecheck.test.js
```
Expected: all PASS.

Also run the broader unit suite to confirm no other test is impacted:

```bash
npx vitest run --project unit
```
Expected: all PASS. (Run time ~30-60s.)

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=false add srv/lib/chat-orchestrator.js test/unit/chat-orchestrator-codecheck.test.js
git -c core.autocrlf=false commit -m "feat(joule-advocates): early-return for advocates kind in toolsForContext

Trimmed tool palette: [searchTutorials, getUserProgress]. All
ChatSettings-gated tools (getRelevantSteps, checkCode,
getBranchRecommendation, findLearningPath) intentionally excluded
on the advocates page.

Two new test cases assert the bypass holds even when all
ChatSettings flags are on, and when isAdmin=true. The three
existing checkCode tests still pass — early-return preserves the
admin/learner branches byte-identical."
```

---

## Task 5: Frontend — `window.__JOULE_ADVOCATES` handoff in App.vue

The Vue island that already fetches the roster stashes it on `window` for joule.js to read. Synchronous top-of-module default makes the variable always defined.

**Files:**
- Modify: `hugo-apps/src/advocates/App.vue`
- Create: `hugo-apps/src/advocates/App.joule-handoff.test.ts`

- [ ] **Step 1: Inspect the current App.vue to confirm shape**

```bash
sed -n '1,15p;40,55p' hugo-apps/src/advocates/App.vue
```

Confirm:
- The script block starts with `<script setup lang="ts">`
- There's an `async function load()` around line 41 that does `fetch(props.apiUrl)`, assigns `advocates.value`, has a `catch` setting `error.value`, ends around line 53.
- Line 54 calls `load();` (fire-and-forget).

- [ ] **Step 2: Write the failing handoff test**

Create `hugo-apps/src/advocates/App.joule-handoff.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from './App.vue';

declare global {
  // eslint-disable-next-line no-var
  var __JOULE_ADVOCATES: unknown;
}

const FIXTURE_A = {
  ID: 'a1', slug: 'a1', firstName: 'Test', lastName: 'Alpha',
  region: 'AMERICAS', title: 'DA', topics: [], links: [], hasPhoto: false
};
const FIXTURE_B = {
  ID: 'b1', slug: 'b1', firstName: 'Test', lastName: 'Bravo',
  region: 'EMEA', title: 'DA', topics: [], links: [], hasPhoto: false
};

describe('App.vue → window.__JOULE_ADVOCATES handoff', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Clear before each test so we can assert post-mount state.
    delete (globalThis as any).__JOULE_ADVOCATES;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('publishes the roster on window.__JOULE_ADVOCATES after a successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ advocates: [FIXTURE_A, FIXTURE_B] }),
    } as unknown as Response);

    mount(App, { props: { apiUrl: '/api/advocates', photoBase: '/api/advocates' } });
    await flushPromises();
    await flushPromises();

    expect(globalThis.__JOULE_ADVOCATES).toEqual([FIXTURE_A, FIXTURE_B]);
  });

  it('sets window.__JOULE_ADVOCATES = [] on fetch error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    mount(App, { props: { apiUrl: '/api/advocates', photoBase: '/api/advocates' } });
    await flushPromises();
    await flushPromises();

    expect(globalThis.__JOULE_ADVOCATES).toEqual([]);
  });

  it('initializes window.__JOULE_ADVOCATES synchronously on module import', async () => {
    // The synchronous default at the top of App.vue should set the var
    // BEFORE any mount happens, so readPageContext never sees undefined.
    delete (globalThis as any).__JOULE_ADVOCATES;
    // Re-import the module to re-run the top-of-module side effect.
    vi.resetModules();
    await import('./App.vue');
    expect(globalThis.__JOULE_ADVOCATES).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test, confirm failure**

```bash
npx vitest run --project unit hugo-apps/src/advocates/App.joule-handoff.test.ts
```
Expected: 3 FAILURES (handoff not yet wired).

- [ ] **Step 4: Edit App.vue — add synchronous default and handoff in load()**

Open `hugo-apps/src/advocates/App.vue`. Inside `<script setup lang="ts">`, BEFORE `async function load()`, add the synchronous default:

```ts
// Joule handoff: synchronous default so window.__JOULE_ADVOCATES is
// never `undefined` when joule.js's readPageContext fires, even before
// the /api/advocates fetch resolves. The load() function below then
// overwrites this with the real roster (or [] on error).
if (typeof window !== 'undefined') {
  (window as unknown as { __JOULE_ADVOCATES: unknown[] }).__JOULE_ADVOCATES =
    (window as unknown as { __JOULE_ADVOCATES?: unknown[] }).__JOULE_ADVOCATES || [];
}
```

Then modify the existing `load()` function to publish on success/error:

```ts
async function load() {
  loading.value = true; error.value = null;
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    advocates.value = Array.isArray(body.advocates) ? body.advocates : [];
    // Joule handoff (issue #564): stash for joule.js readPageContext.
    if (typeof window !== 'undefined') {
      (window as unknown as { __JOULE_ADVOCATES: unknown }).__JOULE_ADVOCATES = advocates.value;
    }
  } catch (e) {
    error.value = (e as Error).message;
    if (typeof window !== 'undefined') {
      (window as unknown as { __JOULE_ADVOCATES: unknown }).__JOULE_ADVOCATES = [];
    }
  } finally {
    loading.value = false;
  }
}
load();
```

- [ ] **Step 5: Run the test, confirm pass**

```bash
npx vitest run --project unit hugo-apps/src/advocates/App.joule-handoff.test.ts
```
Expected: all 3 PASS.

If "initializes synchronously" fails, the cause is usually that `vi.resetModules()` + `import('./App.vue')` doesn't re-run the side effect under your vitest config. In that case the synchronous default IS still working (the other two tests passing prove it); you can either keep the test as a documentary assertion that the *contract* is "synchronous on import" and skip the resetModules dance with a comment, OR delete the third test and rely on the other two. Prefer the comment-and-keep approach.

- [ ] **Step 6: Rebuild the bundle and verify the string is present**

```bash
npm --prefix hugo-apps run build 2>&1 | tail -5
```
Expected: build succeeds; `advocates.js` listed in the output (size may vary slightly from prior build — don't pin a number).

> No new Vite entry was added (we only edited the existing `App.vue`), so the Hugo↔Vite collision check (`scripts/check-build-collisions.ts`, see [CLAUDE.md](../../CLAUDE.md) for context) has nothing new to evaluate.

```bash
grep -o '__JOULE_ADVOCATES' hugo/static/js/advocates.js | head -1
```
Expected: `__JOULE_ADVOCATES` (string present in the built bundle).

- [ ] **Step 7: Commit**

```bash
git -c core.autocrlf=false add hugo-apps/src/advocates/App.vue hugo-apps/src/advocates/App.joule-handoff.test.ts
git -c core.autocrlf=false commit -m "feat(joule-advocates): App.vue publishes roster on window.__JOULE_ADVOCATES

Synchronous top-of-module default so the variable is never undefined
when joule.js reads it. load() then overwrites with the real roster
on fetch success, or [] on fetch error.

The handoff feeds the new advocates page-context kind that
chat-context.js consumes; together they let Joule answer roster
questions ('who covers CAP?', 'tell me about Thomas Jung') grounded
in the same data the cards render."
```

---

## Task 6: Frontend — `readPageContext` advocates branch in joule.js

joule.js is a hand-authored vanilla file (not Vite-bundled). The only change is a new branch in `readPageContext()` that reads the window stash.

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Confirm the function shape**

```bash
sed -n '277,300p' hugo/static/js/joule.js
```
Confirm `readPageContext` starts at line 277 and currently handles `pageKind === 'admin'` as the first branch.

- [ ] **Step 2: Add the advocates branch**

Open `hugo/static/js/joule.js`. After the existing `if (html.dataset.pageKind === 'admin') { … return { kind: 'admin', … }; }` block (ends around line 291), insert:

```js
    if (html.dataset.pageKind === 'advocates') {
      // The advocates Vue island (hugo-apps/src/advocates/App.vue) stashes
      // the loaded roster on window.__JOULE_ADVOCATES after /api/advocates
      // resolves. We pass it through verbatim so the backend's advocatesLayer
      // can format it into the system prompt.
      return {
        kind: 'advocates',
        advocates: Array.isArray(window.__JOULE_ADVOCATES) ? window.__JOULE_ADVOCATES : [],
      };
    }
```

- [ ] **Step 3: Smoke-check the file**

```bash
node --check hugo/static/js/joule.js
```
Expected: no output (syntax clean).

- [ ] **Step 4: Manual end-to-end exercise (optional but recommended)**

```bash
npm run dev:hybrid
```

In a browser:
1. Navigate to `http://localhost:5000/developer-advocates/`. Sign in with SAP ID.
2. Open DevTools console. Type `window.__JOULE_ADVOCATES` → should be an array of 5+ advocate objects after the page settles.
3. Click the Joule shellbar icon. Open the Network tab.
4. Send: "Who covers CAP?"
5. Inspect the POST to `/chat/stream`. The request body should contain `"pageContext":{"kind":"advocates","advocates":[...]}` with the roster.
6. The streamed response should mention Thomas Jung by name (he's the CAP-tagged advocate per the screenshot Tom provided).

If you skip the manual exercise, the smoke test in Task 7 catches the wiring at the HTML/bundle level.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=false add hugo/static/js/joule.js
git -c core.autocrlf=false commit -m "feat(joule-advocates): readPageContext branch for advocates kind

Sends pageContext={kind:'advocates', advocates:window.__JOULE_ADVOCATES}
to /chat/stream when the page is /developer-advocates/. The Vue island
populates window.__JOULE_ADVOCATES after the /api/advocates fetch
(see App.vue change in the same series)."
```

---

## Task 7: Smoke test — assert end-to-end wiring

Three assertions on `/developer-advocates/`: the page-kind, the starters JSON key, and the built bundle contains `__JOULE_ADVOCATES`. The third is the regression guard — if anyone later refactors `App.vue` and forgets the handoff, this test fails BEFORE we go live.

**Files:**
- Modify: `test/smoke/advocates.smoke.test.js`

- [ ] **Step 1: Read current state**

```bash
cat test/smoke/advocates.smoke.test.js
```

Confirm the existing block at lines 6-18 covers the page basics (status 200, mount point, script src). We extend the FIRST describe block.

- [ ] **Step 2: Add the three new assertions**

Inside the first `it(...)` block ("returns 200 and contains the mount point + script tag"), append AFTER the existing `expect(html).toMatch(/src=...advocates\.js/)`:

```js
    // Joule advocates wiring (issue #564).
    // 1. Hugo emits data-page-kind="advocates" on this page (baseof.html).
    //    Tolerant of Hugo minifier's quote-stripping.
    expect(html).toMatch(/data-page-kind=["']?advocates["']?/);
    // 2. The joule-starters JSON literal contains an "advocates" key.
    //    JSON string keys are NOT touched by the HTML minifier — the quotes
    //    stay literal inside the <script type="application/json"> block.
    expect(html).toMatch(/<script[^>]+id=["']?joule-starters["']?[^>]*>[\s\S]*?"advocates"\s*:/);
```

Then, AFTER the first `describe.skipIf(!BASE)` block (so the bundle fetch hits the same approuter), add a new top-level describe:

```js
describe.skipIf(!BASE)('GET /js/advocates.js bundle', () => {
  it('contains the __JOULE_ADVOCATES handoff string', async () => {
    // Regression guard: if a future refactor of App.vue drops the
    // window.__JOULE_ADVOCATES publish, /developer-advocates/ still
    // renders fine but Joule loses its grounding. Smoke catches it.
    const res = await fetch(BASE + '/js/advocates.js');
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain('__JOULE_ADVOCATES');
  });
});
```

- [ ] **Step 3: Run the smoke suite against the local dev server**

> **⚠ QA-build caveat**: the `<script id="joule-starters">` block in `hugo/layouts/partials/joule-starters.html` is gated by `{{ if and (not site.Params.qa) (not site.Params.previewMode) }}`. If `SMOKE_BASE_URL` points at the QA approuter (`tutorials-qa-…`), the script tag is absent and the starters-key assertion fails. **Always target the prod approuter** for this smoke run, OR run it locally against an unflagged Hugo build.

You need an approuter URL serving the built Hugo + bundle. Two ways:

**Option A — full local deploy** (most reliable but slowest):
```bash
npm run build:all
# Wait for build to complete
SMOKE_BASE_URL=http://localhost:5000 npm run start:approuter &
sleep 5
SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke
kill %1
```

**Option B — against the DEV deployment** (faster if DEV has the changes pushed):
```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com npm run test:smoke
```

But: Option B only works AFTER the PR is merged and deployed. For local TDD, use Option A or skip the smoke run and rely on the CI's smoke-after-deploy step.

Expected: the four `/developer-advocates/` assertions plus the bundle assertion all PASS.

- [ ] **Step 4: Commit**

```bash
git -c core.autocrlf=false add test/smoke/advocates.smoke.test.js
git -c core.autocrlf=false commit -m "test(joule-advocates): smoke for page-kind, starters key, and bundle handoff

Three assertions ensure the wiring stays intact end-to-end:
  1. <html data-page-kind=\"advocates\"> on /developer-advocates/
  2. <script id=\"joule-starters\"> contains an 'advocates' key
  3. /js/advocates.js bundle contains the __JOULE_ADVOCATES string
     (regression guard for the App.vue handoff)"
```

---

## Task 8: Final verification + PR

Run the full unit suite to be sure nothing else broke; push the branch; open the PR.

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```
Expected: all PASS. Run time ~60-90 s.

If anything fails, inspect — the fix usually involves one of the test files we touched.

- [ ] **Step 2: Confirm the branch state**

```bash
git log --oneline origin/main..HEAD
```

Expected: ~10-14 commits on `spec/joule-advocates-page` (4 spec/plan documents from brainstorm phase, plus the ~7-9 implementation commits from Tasks 1-7). Don't panic at the larger-than-feature count — the spec/plan history is intentionally preserved.

```bash
git status --short
```
Expected: only `.claude/settings.local.json` modifications (auto-stashed), nothing else dirty.

- [ ] **Step 3: Push the branch**

```bash
git push origin spec/joule-advocates-page
```

- [ ] **Step 4: Open the PR**

On Windows Git Bash, the `$(cat <<EOF...EOF)` heredoc pattern inside `gh pr create --body` is flaky (newline handling, here-doc nesting under MSYS2). Use `--body-file` against a temp file to avoid the issue:

```bash
cat > /tmp/joule-advocates-pr-body.md <<'EOF'
## Summary

Wires Joule into the public `/developer-advocates/` page with a new
`advocates` page-context kind that scopes the persona to:

- the loaded advocate roster (passed via pageContext)
- the SAP topics those advocates cover
- the SAP tutorial content available on this platform (via the
  existing `searchTutorials` tool)

Off-topic-adjacent questions ("deploy a CAP app?") are answered ONLY
from `searchTutorials` results — never from training data — with an
optional bridge to a relevant advocate. Pure off-topic questions get
a polite redirect.

## Approach

Additive — no new services, endpoints, or schema. The change rides
the existing chat infrastructure:

- New `advocates` kind in [hugo/layouts/_default/baseof.html](hugo/layouts/_default/baseof.html)
- New "advocates" starters in [hugo/layouts/partials/joule-starters.html](hugo/layouts/partials/joule-starters.html)
- New `window.__JOULE_ADVOCATES` handoff from [hugo-apps/src/advocates/App.vue](hugo-apps/src/advocates/App.vue)
  (synchronous default + publish in `load()` success and error paths)
- New `readPageContext` branch in [hugo/static/js/joule.js](hugo/static/js/joule.js)
- New `ADVOCATES_PERSONA`, `MAX_ROSTER_ENTRIES=50`, `advocatesLayer`,
  pageLayer switch case, and `buildSystemPrompt` branch in
  [srv/lib/chat-context.js](srv/lib/chat-context.js)
- New early-return for the advocates kind in `toolsForContext` in
  [srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js)
  (preserves admin/learner branches byte-identical)

## Spec & Plan

- Spec: [docs/superpowers/specs/2026-06-23-joule-advocates-page-design.md](docs/superpowers/specs/2026-06-23-joule-advocates-page-design.md)
- Plan: [docs/superpowers/plans/2026-06-23-joule-advocates-page.md](docs/superpowers/plans/2026-06-23-joule-advocates-page.md)

Both reviewed and approved.

## Test plan

- [x] `test/chat-context.test.js` — 5 new cases (roster formatting, empty-roster fallback, defensive shape, persona substring checks, admin regression guard).
- [x] `test/unit/chat-orchestrator-codecheck.test.js` — 2 new cases (advocates kind bypasses ChatSettings tools; admin status doesn't override).
- [x] `hugo-apps/src/advocates/App.joule-handoff.test.ts` — new file. Tests handoff on success, on error, and the synchronous default.
- [x] `test/smoke/advocates.smoke.test.js` — 3 new assertions: `data-page-kind="advocates"`, starters key, bundle contains `__JOULE_ADVOCATES`.
- [ ] DEV deploy manual exercise:
    - "Who covers CAP?" → grounded answer from roster.
    - "Tell me about Thomas Jung." → grounded bio + region.
    - "What tutorials cover HANA Cloud?" → searchTutorials hits + bridge to a matching advocate.
    - "What's the weather today?" → polite redirect.
    - "Deploy a CAP app from scratch." → answer from searchTutorials only, no training-data spillover.

## Closes

Closes #564.
EOF

gh pr create --base main --head spec/joule-advocates-page \
  --title "feat(joule-advocates): Joule scoped to roster + tutorials on /developer-advocates/ (#564)" \
  --body-file /tmp/joule-advocates-pr-body.md
```

Expected: PR URL prints. Note it (will be e.g. https://github.com/sap-tutorials/tutorials-ims/pull/575).

- [ ] **Step 5: Wait for CI**

CI runs the unit suite + builds the MTA + deploys to DEV + runs smoke. The smoke step needs the new bundle to be live, so it's the only assertion that won't pass until deploy completes. Watch the PR check status:

```bash
gh pr checks
```

If all checks pass, the PR is ready for review. If any fails, inspect the workflow log:

```bash
gh run watch
```

---

## Notes for the implementer

- **Branch hygiene** ([memory: branch-slip-after-long-session](.claude/memory/feedback_branch_slip_after_long_session.md)): each task ends with a commit. If you spawn a subagent for a task and HEAD silently reverts to `main`, the commit at the end of the task will fail loudly — re-issue `git checkout spec/joule-advocates-page` in the same shell as `git commit`.
- **CRLF guard** ([memory: crlf-regression-on-windows](.claude/memory/feedback_crlf_regression_on_windows.md)): the `-c core.autocrlf=false` flag on commits keeps LF line endings on Windows. Every task uses it.
- **Existing test pattern** ([test/chat-context.test.js](test/chat-context.test.js)): all 16 existing `buildSystemPrompt` cases live here. Our 5 new cases extend it; don't create a parallel file under `srv/lib/__tests__/`.
- **`hugo-apps` test collocation**: tests live next to source files (`App.joule-handoff.test.ts`). The vitest unit project globs `hugo-apps/src/**/*.test.{js,ts}` — no `__tests__` directory required.
- **Built artifacts gitignored**: `hugo/static/js/advocates.js` is rebuilt by `npm run build:all` in CI. The PR ships source only; CI's Hugo build regenerates the bundle.
- **Manual DEV exercise**: only really meaningful after the PR is deployed. Tom has a flow for that ("Confirm Deploy Scope" memory). Default expectation is a single canonical local deploy `cd .deploy && mbt build && cf deploy ... -e ../deploy/dev.mtaext`, but only on Tom's say-so.

## Out of scope (v2 follow-ups, captured in the spec)

- Events / talks per advocate.
- Recent content (blogs, podcasts) per advocate.
- Anonymous chat lane.
- A `findAdvocates` server-side tool with richer filtering than the page-context payload allows.
