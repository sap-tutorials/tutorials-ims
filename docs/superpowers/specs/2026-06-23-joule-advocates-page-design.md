# Joule on the Developer Advocates Page — Design

**Status:** Approved by Tom 2026-06-23. Awaiting spec review + plan.
**Issue:** [#564 — Joule for Developer Advocates Page](https://github.com/sap-tutorials/tutorials-ims/issues/564)
**Audience:** Anyone implementing this feature; future maintainers tracing how the advocates-specific Joule persona came to exist.

## Problem

The public page at `/developer-advocates/` lists the SAP Developer Advocates as flip-cards with bio, region, topics, and social links (shipped in PRs #572, #573, #574). The site-wide Joule shellbar item is present on this page but uses the **generic** page-context kind — so Joule answers as a tutorial-discovery assistant with no awareness of the advocates roster, no scoping to advocate-related topics, and a tool palette that includes irrelevant things like `getRelevantSteps` and `getBranchRecommendation`.

Tom asked Joule on this page to **only answer questions related to the advocates, the content they create, the topics they cover** — and for topic-adjacent questions ("what tutorials cover CAP?"), to answer **only from SAP tutorial content** (never from the model's training data) and bridge to a relevant advocate when one fits.

## Goals

1. Joule, when invoked on `/developer-advocates/`, answers within a scoped persona: advocates roster, their topics, and SAP tutorial content on this platform.
2. Joule can answer three classes of question:
   - **"Who covers X / who's in region Y"** → name from the loaded roster, plus topics + region + a pointer to their social links.
   - **"Tell me about <named advocate>"** → bio + region + topics + social links, verbatim from the loaded roster.
   - **"What tutorials cover X"** → calls `searchTutorials`, returns 1–3 grounded hits, optionally bridges to an advocate whose topics intersect.
3. Off-topic-adjacent questions (e.g. "deploy a CAP app", "what's HANA Cloud") get answered ONLY from `searchTutorials` results. Joule does NOT volunteer SAP knowledge from training data. If `searchTutorials` returns nothing, Joule says so and suggests an advocate or the `/tutorials/` catalog.
4. Off-topic questions ("write a poem", "what's the weather") get a polite redirect.

## Non-goals (v2 follow-ups)

- Listing upcoming events/talks per advocate. (No data model today.)
- Surfacing recent blogs/podcasts per advocate. (No data model today.)
- Anonymous chat lane on `/developer-advocates/`. Sign-in remains required.
- A new server-side `findAdvocates` tool with rich filtering. The page-context payload pattern is sufficient for v1.

## Architecture

```text
/developer-advocates/  (Hugo)
    │
    ├─ html[data-page-kind="advocates"]              ← new (Hugo baseof + list.html)
    ├─ Vue island fetches /api/advocates             ← existing (PR #572-)
    ├─ Island stashes window.__JOULE_ADVOCATES       ← new (small change in advocates main)
    │
    └─ Click Joule shellbar → window.joule.open()
       │
       └─ POST /chat/stream
          {
            messages: [...],
            pageContext: {
              kind: 'advocates',                     ← new kind
              advocates: [ { firstName, lastName, region, title,
                             pronouns, location, bio, topics, links } ]
            }
          }
          │
          ▼
       srv/lib/chat-context.js
       ├─ ADVOCATES_PERSONA  (new)
       ├─ advocatesLayer()   (new)
       └─ pageLayer switch:  case 'advocates' → advocatesLayer(ctx)

       srv/lib/chat-orchestrator.js
       └─ toolsForContext({ kind: 'advocates' }) → [searchTutorials, getUserProgress*]
          (* getUserProgress for signed-in users — already conditional)
```

No new services, no new HTTP endpoints, no new database tables. The work is entirely additive to existing files.

## Components

### Hugo (templates)

**[hugo/layouts/_default/baseof.html](hugo/layouts/_default/baseof.html)** — extend the `data-page-kind` ternary:

```diff
- {{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}
+ {{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else if eq .Type "developer-advocates" }}advocates{{ else }}generic{{ end }}
```

**[hugo/layouts/partials/joule-starters.html](hugo/layouts/partials/joule-starters.html)** — add an `"advocates"` key to the starters JSON literal:

```json
"advocates": [
  "Who can I follow for CAP?",
  "Show me tutorials by our advocates on HANA Cloud.",
  "Where is Thomas Jung based and what does he focus on?"
]
```

(Tom can swap these wordings before launch; the structure is the surface area.)

### Frontend (Vue island)

**[hugo-apps/src/advocates/App.vue](hugo-apps/src/advocates/App.vue)** — the `/api/advocates` fetch lives in the `load()` async function (App.vue:41-53), NOT in `main.ts` (which only calls `createApp(App).mount(...)` and never touches the API). Add the handoff inside `load()`:

```ts
// Top-of-module (after the script setup imports) — synchronous default
// so window.__JOULE_ADVOCATES is NEVER undefined when readPageContext
// runs (chat-context reviewer flagged the cold-open race as needing a
// stronger guarantee than "self-heals on next message").
if (typeof window !== 'undefined') {
  (window as any).__JOULE_ADVOCATES = (window as any).__JOULE_ADVOCATES || [];
}

async function load() {
  loading.value = true; error.value = null;
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    advocates.value = Array.isArray(body.advocates) ? body.advocates : [];
    // Stash for joule.js's readPageContext.
    (window as any).__JOULE_ADVOCATES = advocates.value;
  } catch (e) {
    error.value = (e as Error).message;
    (window as any).__JOULE_ADVOCATES = [];
  } finally {
    loading.value = false;
  }
}
```

This is the *only* mildly clever bit in the design. The Vue island already has the roster; passing it to a vanilla-JS sibling (`joule.js`) via `window` is simpler than a duplicate `/api/advocates` fetch from `joule.js` itself. The two pieces are on the same page, run in the same tab, and don't share a module graph today — `window` is the agreed handoff surface.

**[hugo-apps/src/advocates/main.ts](hugo-apps/src/advocates/main.ts)** — unchanged. Documented here only to record that we considered putting the stash there and rejected it (the fetch isn't in this file).

### Frontend (vanilla-JS Joule)

**[hugo/static/js/joule.js](hugo/static/js/joule.js)** — extend `readPageContext()`:

```js
// inside readPageContext()
if (html.dataset.pageKind === 'advocates') {
  return {
    kind: 'advocates',
    advocates: Array.isArray(window.__JOULE_ADVOCATES) ? window.__JOULE_ADVOCATES : []
  };
}
```

No bundle rebuild — `joule.js` is a hand-authored vanilla file, not Vite-bundled.

### Backend (system prompt)

**[srv/lib/chat-context.js](srv/lib/chat-context.js)** — add three additions:

1. `ADVOCATES_PERSONA` constant:

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
   ```

2. `advocatesLayer(pageContext)` function:

   ```js
   const MAX_ROSTER_ENTRIES = 50;  // hard ceiling on what we render into
                                    // the prompt. Server-side defense against
                                    // an oversized client payload. Today's
                                    // roster is ~5; raise if it grows past 30.

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

3. `pageLayer` switch + `buildSystemPrompt` branch:

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

   export function buildSystemPrompt(pageContext, user) {
     const isAdmin = pageContext?.kind === 'admin';
     const isAdvocates = pageContext?.kind === 'advocates';
     const persona = isAdmin ? ADMIN_PERSONA
                   : isAdvocates ? ADVOCATES_PERSONA
                   : PERSONA;
     // Preserve existing layer ordering for admin (gets RAG_GUIDANCE
     // today) and learner (gets RAG_GUIDANCE + PROGRESS_GUIDANCE).
     // ONLY the new advocates kind opts out of both — getRelevantSteps
     // and getUserProgress workflows aren't relevant on this page.
     const layers = [persona];
     if (!isAdvocates) layers.push(RAG_GUIDANCE);
     if (!isAdmin && !isAdvocates) layers.push(PROGRESS_GUIDANCE);
     layers.push(pageLayer(pageContext), userLayer(user));
     return layers.filter(Boolean).join('\n\n');
   }
   ```

   Verified intent: today's admin path is `[ADMIN_PERSONA, RAG_GUIDANCE, adminLayer, userLayer]` (no PROGRESS_GUIDANCE). The rewrite preserves that exactly — admin still gets `RAG_GUIDANCE`. Only the new `advocates` path strips both `RAG_GUIDANCE` and `PROGRESS_GUIDANCE`. Existing learner / search / tutorial / mission / group prompts remain byte-identical.

### Backend (tool palette)

**[srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js)** — extend `toolsForContext`.

**Key constraint** (caught in spec review iter 1): today the ChatSettings-gated block at orchestrator.js:187-204 runs UNCONDITIONALLY for both admin and learner kinds. The existing test at [test/unit/chat-orchestrator-codecheck.test.js:25-35](test/unit/chat-orchestrator-codecheck.test.js#L25-L35) asserts `kind: 'tutorial'` includes `checkCode` when `codeCheckEnabled=true`. Our change must preserve every existing kind's tool set EXACTLY; only the new `advocates` kind opts out.

The minimal, side-effect-free diff is an early-return for the `advocates` branch:

```js
async function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];

  // Advocates page: trimmed palette. searchTutorials + (optional)
  // getUserProgress for signed-in users. ChatSettings-gated tools
  // (getRelevantSteps, checkCode, getBranchRecommendation,
  // findLearningPath) are intentionally excluded — off-scope on
  // /developer-advocates/. Early return keeps the existing admin
  // and learner branches below byte-identical.
  if (pageContext?.kind === 'advocates') {
    tools.push(GET_USER_PROGRESS_TOOL);
    return tools;
  }

  // Existing logic — unchanged.
  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GENERATE_ANALYTICS_QUERY_TOOL, EXPLAIN_ANALYTICS_RESULT_TOOL);
  } else {
    tools.push(GET_USER_PROGRESS_TOOL);
  }
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings);
    if (settings?.ragEnabled)             tools.push(GET_RELEVANT_STEPS_TOOL);
    if (settings?.codeCheckEnabled)       tools.push(CHECK_CODE_TOOL);
    if (settings?.branchingEnabled)       tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
    if (settings?.kgPathBetweenEnabled)   tools.push(FIND_LEARNING_PATH_TOOL);
  } catch (err) {
    LOG.warn('toolsForContext: could not read ChatSettings', err.message);
  }
  return tools;
}
```

Note: `getUserProgress` is included for `advocates` kind even though the persona doesn't actively encourage calling it, because a signed-in advocate visitor might still ask "show me my in-progress tutorials". Cheap to keep.

## Data flow

1. User loads `/developer-advocates/`. Hugo's `baseof.html` emits `<html data-page-kind="advocates" ...>`.
2. The advocates Vue island's `App.vue` mounts and runs `load()`, which calls `fetch('/api/advocates')`. On resolve, after assigning `advocates.value`, it sets `window.__JOULE_ADVOCATES = advocates.value`. On error, it sets `window.__JOULE_ADVOCATES = []`. A synchronous top-of-module default also initializes `window.__JOULE_ADVOCATES = []` so the variable is never `undefined`, even before `load()` has finished.
3. User clicks the Joule shellbar item. Existing site-wide `joule.js` opens the panel.
4. User sends a message. `readPageContext()` recognises `data-page-kind="advocates"` and emits `{ kind: 'advocates', advocates: window.__JOULE_ADVOCATES || [] }`.
5. POST `/chat/stream` carries the page-context. CAP authenticates via XSUAA (existing behavior).
6. `chatStreamHandler` calls `buildSystemPrompt(pageContext, user)` → emits `ADVOCATES_PERSONA` + `advocatesLayer(pageContext)` + `userLayer(user)`. Skips `RAG_GUIDANCE` and `PROGRESS_GUIDANCE`.
7. `toolsForContext({ pageContext, isAdmin: false })` returns `[searchTutorials, getUserProgress]`.
8. Orchestrator streams the model response via existing SSE.

## Error handling

| Failure mode | Behavior |
|---|---|
| Race: user opens Joule before `/api/advocates` resolves | `window.__JOULE_ADVOCATES` is undefined → `readPageContext` sends `advocates: []` → `advocatesLayer` returns the empty-roster prompt fragment instructing Joule to ask the user to wait and only use `searchTutorials` until the next message. Self-heals on the next message. |
| `/api/advocates` returns error | Vue island handles its own empty-state UI; we set `window.__JOULE_ADVOCATES = []` in the error path so Joule degrades to the same empty-roster behavior. |
| `searchTutorials` returns no hits | Persona instructs: "say so explicitly, suggest the user reach out to a relevant advocate or explore /tutorials/." |
| Model attempts to invent an advocate or tutorial slug | The persona contains hard "never invent" clauses pinned to the roster. The grounded roster + ranked tool results are the only allowable sources. |
| Payload size: very large roster | Today's roster is ~5 advocates × ~50 tokens. Cap at 50 advocates in `advocatesLayer` before truncation logic ever matters. Not implementing a budget today; flag as TODO if the roster ever grows past 30 entries. |

## Testing

### Unit — backend

**Extend: [test/chat-context.test.js](test/chat-context.test.js)** (16 existing `buildSystemPrompt` cases live here — keep the convention):
- `buildSystemPrompt({ kind: 'advocates', advocates: [fixture] }, user)` includes the persona signature ("Developer Advocates page"), the fixture advocate's name, and the topic-bridge instruction.
- Does NOT include `PROGRESS_GUIDANCE` substring ("getUserProgress tool") or `RAG_GUIDANCE` substring ("getRelevantSteps tool").
- Empty-roster fallback: `buildSystemPrompt({ kind: 'advocates', advocates: [] }, user)` includes the "has not loaded yet" guidance.
- Defensive shape: `buildSystemPrompt({ kind: 'advocates', advocates: 'not-an-array' }, user)` does NOT throw, falls back to the empty-roster prompt. (Guards against client-side payload shape regressions.)
- Regression guard: `buildSystemPrompt({ kind: 'admin', tool: 'analytics-builder' }, user)` still contains `RAG_GUIDANCE` substring (admin path unchanged).

**Extend: [test/unit/chat-orchestrator-codecheck.test.js](test/unit/chat-orchestrator-codecheck.test.js)** (owns `toolsForContext` assertions):
- `toolsForContext({ pageContext: { kind: 'advocates' }, isAdmin: false })` with `codeCheckEnabled=true` AND `ragEnabled=true` returns exactly `[searchTutorials, getUserProgress]`. (Confirms the early-return bypasses ALL ChatSettings tools, even when the flags are on.)
- Same call with `isAdmin=true` (a signed-in admin browsing the advocates page) still returns the trimmed palette — admin status doesn't override the page-context scoping here.
- Regression guard: `toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false })` with `codeCheckEnabled=true` still includes `checkCode` (the existing test stays green).

### Unit — frontend

**New: [hugo-apps/src/advocates/__tests__/joule-handoff.test.ts](hugo-apps/src/advocates/__tests__/joule-handoff.test.ts)** (or alongside the existing `__tests__` if one exists for advocates):
- Mount `App.vue` with a mocked `fetch('/api/advocates')` returning `{ advocates: [fixtureA, fixtureB] }`. Assert `window.__JOULE_ADVOCATES` equals `[fixtureA, fixtureB]` after `load()` resolves.
- Mount with mocked `fetch` rejection. Assert `window.__JOULE_ADVOCATES === []` after the error path runs.
- Synchronous default: import the module and assert `window.__JOULE_ADVOCATES` is `[]` BEFORE `load()` even starts (the top-of-module side-effect must run on import).

### Smoke

**Extend: [test/smoke/advocates.smoke.test.js](test/smoke/advocates.smoke.test.js)** (already asserts `src="/js/advocates.js"`):
- `GET /developer-advocates/` response body includes `data-page-kind="advocates"` (regex tolerates Hugo minifier's attribute-quote stripping per `feedback_hugo_minifier_strips_quotes` memory).
- Same response contains a `<script id="joule-starters">` element (regex anchors on `id=` + `"joule-starters"`, with optional quote-stripping).
- The actual `"advocates"` JSON key inside the starters block is a JSON literal — minifier preserves JSON string keys, so a literal substring match for `"advocates":` is reliable.
- **Bundle regression guard**: assert the served `/js/advocates.js` bundle contains the string `__JOULE_ADVOCATES`. Catches a silent regression where someone refactors `App.vue` and forgets the handoff. Without this, the smoke test would still pass even if the Vue island stopped setting the window var. (Reviewer flagged this gap in iter 1.)

### Not tested

- Live LLM responses. The orchestrator's model call is mocked across the suite; we don't run real LLM eval here. Manual testing on DEV is the gate.
- Visual rendering of the chat panel — no UI change in this PR; we're only changing the prompt + tool palette.

## Operational notes

- **Memory `feedback_ui5_dollar_vs_percent_binding`** does not apply — no UI5/FE V4 binding changes in this PR.
- **Memory `feedback_hugo_minifier_strips_quotes`** applies to the smoke test regex (use double-quote-optional matcher).
- **Memory `feedback_vue_scoped_style_beats_unscoped_css`** does not apply — no styling change.
- **`/chat/stream` rate limit** — Joule's existing per-user limit applies unchanged.
- **No env vars or secrets** — no new config knobs.
- **No DB schema change** — no `cds deploy` impact.

## File checklist

| File | Action |
|---|---|
| `hugo/layouts/_default/baseof.html` | Edit — extend `data-page-kind` ternary. |
| `hugo/layouts/partials/joule-starters.html` | Edit — add `"advocates"` starter set. |
| `hugo-apps/src/advocates/App.vue` | Edit — synchronous default + `window.__JOULE_ADVOCATES` in `load()` success/error. |
| `hugo-apps/src/advocates/main.ts` | **No change** (the fetch isn't here). Listed only for traceability. |
| `hugo/static/js/joule.js` | Edit — `readPageContext` advocates branch. |
| `srv/lib/chat-context.js` | Edit — `ADVOCATES_PERSONA`, `MAX_ROSTER_ENTRIES`, `advocatesLayer`, switch case, `buildSystemPrompt` branch. |
| `srv/lib/chat-orchestrator.js` | Edit — early-return advocates branch in `toolsForContext`. |
| `test/chat-context.test.js` | Edit — new test cases for `kind: 'advocates'` + regression guard for `kind: 'admin'`. |
| `test/unit/chat-orchestrator-codecheck.test.js` | Edit — assert advocates kind bypasses ChatSettings tools; existing tutorial test stays green. |
| `hugo-apps/src/advocates/__tests__/joule-handoff.test.ts` | New — frontend handoff unit test (incl. synchronous default + error path). |
| `test/smoke/advocates.smoke.test.js` | Edit — assert `data-page-kind="advocates"`, starters block contains `"advocates"`, AND served `/js/advocates.js` bundle contains the string `__JOULE_ADVOCATES`. |

## Rollout

1. Single PR with all the above. No flag — the scope change is contained to one page.
2. After deploy, manually exercise on DEV:
   - "Who covers CAP?" → grounded answer from roster.
   - "Tell me about Thomas Jung." → grounded bio + region + topics.
   - "What tutorials cover HANA Cloud?" → `searchTutorials` hits, bridge to a matching advocate.
   - "What's the weather today?" → polite redirect.
   - "Deploy a CAP app from scratch." → `searchTutorials` answer only, no training-data spillover; falls back to /tutorials/ link if no hits.
3. Verify the existing learner / admin / search / tutorial Joule personas are unchanged by spot-checking each on DEV.

## Risks

| Risk | Mitigation |
|---|---|
| Model still volunteers training-data SAP answers despite the persona's "do NOT" clause | The persona language is direct. If model behavior drifts in practice, follow up with a stricter system-prompt review or expand the unit tests to assert specific substring presence in the prompt. Manual DEV testing in the rollout step catches regressions. |
| Roster doesn't load → user sees a vague answer | The empty-roster prompt fragment instructs Joule to say so and retry on next message. The synchronous default `window.__JOULE_ADVOCATES = []` at the top of `App.vue` guarantees `readPageContext` never sees `undefined` — eliminates one race class. Acceptable; the alternative (block sending until loaded) breaks the open-immediately UX the site established. |
| Advocate edits in admin take time to reach the roster (cache TTL) | The `/api/advocates` route caches 60 s by default. A fresh page load triggers a re-fetch; manually waiting 60 s suffices for new uploads. Not changing in this PR. |
| Token cost: roster sent on every chat request from this page | Today: ~5 advocates × ~50 tokens = ~250 tokens system-prompt overhead per request, well within the model's context budget and not measurably cost-impactful at expected QPS. `MAX_ROSTER_ENTRIES = 50` caps growth. Re-evaluate if roster exceeds 30 advocates or if Joule QPS grows 100x. |
| Privacy: bio + location + region + links in the system prompt | All fields are already public on the `/developer-advocates/` page (rendered on the cards Tom shipped in PRs #572-574). No incremental privacy surface area; we're just plumbing the page's own data into the same page's chat panel. The `/api/advocates` endpoint that supplies the data is itself unauthenticated and intended for public consumption. |
| Cross-talk: stale `window.__JOULE_ADVOCATES` from a previous page | Hugo pages are full reloads, not SPA navigations — `window` is freshly minted on every visit. Even if a future SPA refactor changed this, `readPageContext` keys off `data-page-kind` first; the advocates branch wouldn't execute on a non-advocates page. Defense in depth. |
| Descendant pages under `/developer-advocates/` (e.g. future `/developer-advocates/<slug>/`) inherit `.Type` | Hugo's `.Type` is inherited by descendants of the section. If we ever add per-advocate detail pages, they'll get `data-page-kind="advocates"` automatically — likely desirable (same persona) but worth re-reading this risk row before adding any. |
