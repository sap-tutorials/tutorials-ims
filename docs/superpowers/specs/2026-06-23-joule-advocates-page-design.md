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

**[hugo-apps/src/advocates/main.ts](hugo-apps/src/advocates/main.ts)** — after the `/api/advocates` fetch resolves (success OR error), stash the result on `window`:

```ts
// After fetch resolves
window.__JOULE_ADVOCATES = response?.advocates ?? [];
// In the error path
window.__JOULE_ADVOCATES = [];
```

This is the *only* mildly clever bit in the design. The Vue island already has the roster; passing it to a vanilla-JS sibling (`joule.js`) via `window` is simpler than a duplicate `/api/advocates` fetch from `joule.js` itself. The two pieces are on the same page, run in the same tab, and don't share a module graph today — `window` is the agreed handoff surface.

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
   function advocatesLayer(ctx) {
     const advocates = Array.isArray(ctx.advocates) ? ctx.advocates : [];
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
     // RAG_GUIDANCE and PROGRESS_GUIDANCE both reference learner workflows
     // (resume, recommend, getRelevantSteps) that are off-scope on the
     // advocates page. Skip them.
     const layers = [persona];
     if (!isAdmin && !isAdvocates) {
       layers.push(RAG_GUIDANCE);
       layers.push(PROGRESS_GUIDANCE);
     }
     layers.push(pageLayer(pageContext), userLayer(user));
     return layers.filter(Boolean).join('\n\n');
   }
   ```

### Backend (tool palette)

**[srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js)** — extend `toolsForContext`:

```js
async function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];
  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GENERATE_ANALYTICS_QUERY_TOOL, EXPLAIN_ANALYTICS_RESULT_TOOL);
  } else if (pageContext?.kind === 'advocates') {
    // Scoped palette for /developer-advocates/. searchTutorials is the
    // only content lookup; getUserProgress remains conditional on auth
    // (same as the learner kind). All other tools (getRelevantSteps,
    // checkCode, getBranchRecommendation, findLearningPath) are
    // off-scope on this page.
    tools.push(GET_USER_PROGRESS_TOOL);
  } else {
    tools.push(GET_USER_PROGRESS_TOOL);
    // ChatSettings-gated tools — skipped for advocates kind by design.
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      const settings = await SELECT.one.from(ChatSettings);
      if (settings?.ragEnabled)        tools.push(GET_RELEVANT_STEPS_TOOL);
      if (settings?.codeCheckEnabled)  tools.push(CHECK_CODE_TOOL);
      if (settings?.branchingEnabled)  tools.push(GET_BRANCH_RECOMMENDATION_TOOL);
      if (settings?.kgPathBetweenEnabled) tools.push(FIND_LEARNING_PATH_TOOL);
    } catch (err) {
      LOG.warn('toolsForContext: could not read ChatSettings', err.message);
    }
  }
  return tools;
}
```

Note: `getUserProgress` is included for `advocates` kind even though the persona doesn't actively encourage calling it, because a signed-in advocate visitor might still ask "show me my in-progress tutorials". Cheap to keep.

## Data flow

1. User loads `/developer-advocates/`. Hugo's `baseof.html` emits `<html data-page-kind="advocates" ...>`.
2. The advocates Vue island's `main.ts` mounts the app and calls `fetch('/api/advocates')`. On resolve, before mounting cards, it sets `window.__JOULE_ADVOCATES = response.advocates`. On error, it sets `window.__JOULE_ADVOCATES = []`.
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

**New: [srv/lib/__tests__/chat-context-advocates.test.js](srv/lib/__tests__/chat-context-advocates.test.js)**:
- `buildSystemPrompt({ kind: 'advocates', advocates: [fixture] }, user)` includes the persona signature ("Developer Advocates page"), the fixture advocate's name, and the topic-bridge instruction.
- Does NOT include `PROGRESS_GUIDANCE` substring ("getUserProgress tool") or `RAG_GUIDANCE` substring ("getRelevantSteps tool").
- Empty-roster fallback: `buildSystemPrompt({ kind: 'advocates', advocates: [] }, user)` includes the "has not loaded yet" guidance.

**Extend: [srv/lib/__tests__/chat-orchestrator-analytics-tools.test.js](srv/lib/__tests__/chat-orchestrator-analytics-tools.test.js)** (or whichever test file owns `toolsForContext` shape today):
- `toolsForContext({ pageContext: { kind: 'advocates' }, isAdmin: false })` returns exactly `[searchTutorials, getUserProgress]`. No `getRelevantSteps`, no `checkCode`, no `getBranchRecommendation`, no `findLearningPath` — even when ChatSettings flips those on.

### Unit — frontend

**New: [hugo-apps/src/advocates/__tests__/joule-handoff.test.ts](hugo-apps/src/advocates/__tests__/joule-handoff.test.ts)**:
- Mock `fetch('/api/advocates')` → assert `window.__JOULE_ADVOCATES` equals the response's `advocates` array after the promise resolves.
- Mock `fetch` rejection → assert `window.__JOULE_ADVOCATES` is `[]` after the error path runs.

### Smoke

**Extend: [test/smoke/](test/smoke/)** existing smoke that hits HTML pages:
- `GET /developer-advocates/` response body includes `data-page-kind="advocates"`.
- Same response contains `<script id="joule-starters"` with an `"advocates"` key (regex-tolerant of minifier-stripped attribute quotes per `feedback_hugo_minifier_strips_quotes` memory).

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
| `hugo-apps/src/advocates/main.ts` | Edit — set `window.__JOULE_ADVOCATES`. |
| `hugo/static/js/joule.js` | Edit — `readPageContext` advocates branch. |
| `srv/lib/chat-context.js` | Edit — `ADVOCATES_PERSONA`, `advocatesLayer`, switch, `buildSystemPrompt`. |
| `srv/lib/chat-orchestrator.js` | Edit — `toolsForContext` advocates branch. |
| `srv/lib/__tests__/chat-context-advocates.test.js` | New — backend prompt unit tests. |
| `srv/lib/__tests__/chat-orchestrator-analytics-tools.test.js` | Edit — tool palette assertion for advocates kind. |
| `hugo-apps/src/advocates/__tests__/joule-handoff.test.ts` | New — frontend handoff unit test. |
| `test/smoke/` | Edit (one file) — assert `data-page-kind="advocates"` on the public page. |

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
| Roster doesn't load → user sees a vague answer | The empty-roster prompt fragment instructs Joule to say so and retry on next message. Acceptable; the alternative (block sending until loaded) breaks the open-immediately UX the site established. |
| Advocate edits in admin take time to reach the roster (cache TTL) | The `/api/advocates` route caches 60 s by default. A fresh page load triggers a re-fetch; manually waiting 60 s suffices for new uploads. Not changing in this PR. |
