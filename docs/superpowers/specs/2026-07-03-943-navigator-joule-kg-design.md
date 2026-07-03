# Navigator Joule Handoff & KG-Backed Search Expansion

**Issue:** [#943](https://github.com/sap-tutorials/tutorials-ims/issues/943) — Tutorial Navigator Search Improvements
**Related PR (Part 1, shipped):** [#944](https://github.com/sap-tutorials/tutorials-ims/pull/944) — CAP v4 parser regression fix
**Date:** 2026-07-03
**Status:** Design — awaiting user review before plan

---

## Summary

Issue #943 has three parts:

1. **Part 1 — Fix current "no results" regression** (shipped as PR #944). OData V4 parser rejected the v2-style `taskTypes=['TUTORIAL']` inline literal that a prior refactor introduced. Replaced with V4 parameter aliases + JSON array literals. 17 unit tests, all green.
2. **Part 2 — Joule handoff button** in the navigator: user types a query, clicks a Joule icon next to the search box, Joule opens and immediately asks Joule to find matching tutorials using a canned prompt template.
3. **Part 3 — Knowledge Graph in Joule search**: a new Joule tool, `expandSearchConcepts`, that maps a query to related KG concepts and their most-linked tutorials. Joule is prompted to call it *first* for search-like queries, then optionally `searchTutorials` for keyword coverage, then combine.

Parts 2 and 3 are the scope of this spec. Part 1 is complete.

## Goals

- Give navigator users a one-click bridge from search into Joule when keyword search is not enough.
- Surface KG relationships (concept → concept, concept → tutorial) into the chat answer so Joule can explain *why* a tutorial is relevant, not just list matches.
- Ship as an incremental, feature-flagged capability — no regressions to current search, existing Joule tools, or existing KG-Joule tool (`findLearningPath`).

## Non-goals (parked, see issues below)

- Server-side reranking of `/search/SearchableItems` using KG signal (parked → #945)
- New `window.joule.openWithPrefill` primitive for prefill-without-send (parked → #946)
- KG-boosted ranking *inside* the existing `searchTutorials` tool (parked → #945)
- Multi-language concept expansion (parked → #947)
- On-demand KG rebuild triggers from the new tool (parked → #948)

---

## Section 1 — Joule handoff button (Part 2)

### UX

Place a small icon button immediately right of the existing search `<input>` inside `hugo-apps/src/navigator/TutorialNavigator.vue`. The button is **always visible**, matches the existing Fundamental Styles button chrome, and uses the `sap-icon--ai` glyph to signal "AI assistant".

Behaviour on click:

- **Empty query** → open Joule with no message (`window.joule.open()`).
- **Non-empty query** → send a canned prompt via `window.joule.openWithMessage({ text })`. Joule opens *and* submits the prompt in the same call — this is the intended UX for a user who already typed a specific query.

The canned prompt template:

```
Find tutorials about: <query>

Use the expandSearchConcepts tool for related concepts,
then searchTutorials for keyword matches.
Summarise the top results with why they're relevant.
```

This is a plain string, not user-visible chrome — the LLM sees it, executes the two tool calls, and produces a summarised response.

### Implementation sketch

New elements in `TutorialNavigator.vue`:

```html
<button
  class="fd-button fd-button--transparent joule-search-btn"
  :aria-label="'Ask Joule about ' + (searchTerm || 'tutorials')"
  @click="handleJouleClick"
>
  <i class="sap-icon--ai"></i>
</button>
```

```typescript
function handleJouleClick() {
  const query = searchTerm.value?.trim() ?? ''
  if (!query) {
    window.joule?.open?.()
    return
  }
  const template = [
    `Find tutorials about: ${query}`,
    `Use the expandSearchConcepts tool for related concepts, then searchTutorials for keyword matches. Summarise the top results with why they're relevant.`,
  ].join('\n\n')
  window.joule?.openWithMessage?.({ text: template })
  window.dispatchEvent(new CustomEvent('joule:search_handoff', {
    detail: { queryLength: query.length, hasFilters: hasAnyFilterActive() }
  }))
}
```

The `joule:search_handoff` custom event is emitted for the shared analytics pipeline (matches the pattern used by the Advocates page for `joule:advocates_handoff`). No PII in the payload — length + filter-state only.

### Feature flag

None — the button is always visible. If Joule is disabled globally (`ChatSettings.enabled = false`), `window.joule` is undefined and the click is a no-op. That is the same graceful-degradation contract that other Joule-integrated pages already use.

---

## Section 2 — KG-backed `expandSearchConcepts` Joule tool (Part 3)

### Contract

New tool descriptor (parallels `srv/lib/kg/joule-tool-find-path.js`):

```js
{
  name: 'expandSearchConcepts',
  description:
    'Given a free-text search query, return related knowledge-graph concepts ' +
    'plus the most relevant tutorials with short rationales. Use FIRST when the ' +
    'user asks to find or search for tutorials on a topic; then call ' +
    'searchTutorials for keyword matches to complement it.',
  input_schema: {
    type: 'object',
    properties: {
      query:        { type: 'string',  minLength: 1, maxLength: 200 },
      maxConcepts:  { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      maxTutorials: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
    },
    required: ['query']
  }
}
```

Response shape:

```json
{
  "queryEcho": "abap async",
  "concepts": [
    { "slug": "async-abap", "name": "Asynchronous ABAP", "score": 0.87 }
  ],
  "tutorials": [
    {
      "slug": "abap-async-rap",
      "title": "Async RAP in ABAP Cloud",
      "rationale": "Teaches Asynchronous ABAP and Event-Driven Architecture",
      "score": 0.81
    }
  ]
}
```

### Algorithm

1. **Embed the query** using the standard AI Core embedding client (`srv/lib/embedding-client.js`).
2. **Cosine over `Concepts.embedding`** (`status='ACTIVE'`) via `srv/lib/embedding-query.js`. HANA path uses raw `db.run()` — never SELECT the BLOB alongside metadata (see `feedback_hana_lob_locator_expiry` note in project docs). SQLite path uses JS-side cosine.
3. **Top-`maxConcepts`** concepts by cosine similarity.
4. **1-hop walk on `ConceptEdges`** (`predicate IN ('requires','relatedTo')`), boosting neighbours by `0.5 × source_score × edge_confidence`. Merge back into the concept set, re-sort, cap at `maxConcepts`. Depth is fixed at 1 in v1 — deeper walks are out of scope until we have usage data.
5. **Join `TutorialConceptLinks`** (`predicate = 'teaches'`) to collect candidate tutorials.
6. **Aggregate**: for each tutorial, score = Σ (concept_score × link_confidence) over its linked concepts (from step 4).
7. **Top-`maxTutorials`** by score.
8. **Build rationale**: names of the top 2 linked concepts for that tutorial, joined with " and ". Falls back to top 1 name if only one link exists.
9. **Return** the shape above.

### Registration and prompt guidance

- Register the tool in `srv/lib/chat-orchestrator.js`, gated on new flag `ChatSettings.kgSearchExpansionEnabled` (default `true`, follows the same pattern as `kgPathBetweenEnabled`).
- Add a line to the chat system prompt (also gated):

  > When the user asks to find or search for tutorials on a topic, prefer calling `expandSearchConcepts` first, then `searchTutorials` for narrow keyword matches. Combine both signals in your response — mention the top concept relationships when they add clarity.

### Schema change

Add to `db/schema.cds`:

```cds
kgSearchExpansionEnabled : Boolean default true;
```

on the `ChatSettings` singleton. This requires a `cds build --production` before deploy (per `feedback_cds_build_production_not_cds_compile_for_last_dev`) and staging into `db/last-dev/csn.json`.

---

## Section 3 — Data flow, error handling, testing

### End-to-end data flow

```
User in TutorialNavigator.vue
  └─ types query, clicks Joule button
      └─ window.joule.openWithMessage({ text: canned prompt })
          └─ Joule frame opens; LLM receives system prompt + user prompt
              ├─ LLM chooses tool_use → expandSearchConcepts { query, maxConcepts, maxTutorials }
              │   └─ orchestrator invokes srv/lib/kg/joule-tool-expand-concepts.js
              │       └─ embed → cosine over Concepts → 1-hop ConceptEdges walk
              │         → join TutorialConceptLinks → aggregate → return JSON
              ├─ LLM optionally follows up with tool_use → searchTutorials { query }
              │   └─ existing tool (unchanged) — keyword matches over SearchableItems
              └─ LLM composes response combining concepts + keyword hits with rationales
```

### Error handling

| Failure mode                          | Behaviour                                                                                          |
|---------------------------------------|----------------------------------------------------------------------------------------------------|
| Tool timeout (> 5s)                   | Return `{ concepts: [], tutorials: [], warning: 'timeout' }`; LLM falls back to `searchTutorials`. |
| Invalid query (empty after trim)      | Tool returns 400-shaped error; orchestrator surfaces as tool_result with `is_error: true`.         |
| KG has zero ACTIVE concepts           | Tool returns `{ concepts: [], tutorials: [] }`; LLM proceeds with `searchTutorials` alone.         |
| `kgSearchExpansionEnabled = false`    | Tool not registered; LLM never sees it in the tool list. No runtime error path.                     |
| `window.joule` undefined (Joule off)  | Button click is a no-op. No banner, no error toast — matches existing Joule-integrated pages.       |
| HANA connection error                 | Tool returns `is_error: true` with sanitised message. LLM apologises and falls back.               |

Timeout is enforced in the tool handler via `AbortController` on the embedding call and a wall-clock check before the DB query.

### Testing plan

Four tiers, matching the project convention (`vitest.config.ts` inline `projects`):

1. **Vue unit** — `hugo-apps/src/navigator/TutorialNavigator.joule.test.ts` (happy-dom).
   - Renders the button; asserts `aria-label` reflects search term.
   - Mocks `window.joule`; asserts `open()` on empty query, `openWithMessage({ text })` on non-empty.
   - Asserts `joule:search_handoff` CustomEvent is dispatched with `queryLength` + `hasFilters`.
2. **Node unit** — `test/unit/kg/joule-tool-expand-concepts.test.js` (in-memory SQLite).
   - Seeds a tiny KG (3 concepts, 2 edges, 4 links, 2 tutorials).
   - Asserts scoring formula, rationale composition, `maxConcepts`/`maxTutorials` truncation.
   - Asserts empty-KG and invalid-query branches.
3. **Hybrid HANA** — `test/hybrid/kg-search-expansion.test.js` (real HANA via `cds bind --exec`).
   - Verifies HANA cosine path (raw `db.run`) matches SQLite path within tolerance.
   - Uses `__TEST__`-prefixed rows; requires `ALLOW_HYBRID_WRITES=true`; cleans up in `afterAll`.
4. **Smoke** — `test/smoke/joule-search.smoke.test.js` (post-deploy).
   - Hits `/chat/stream` with a canned "find tutorials about abap" prompt; asserts the SSE stream contains at least one `tool_use` block with `name = expandSearchConcepts` and a non-empty `tutorials` result.

---

## Rollout

1. Land schema change + `cds build --production`; stage `db/last-dev/csn.json`.
2. Land tool implementation and orchestrator registration behind default-on flag.
3. Land navigator button.
4. Deploy DEV; verify smoke test.
5. Manual walkthrough: type `abap async` in navigator search, click Joule, confirm concepts + tutorials appear in the answer.
6. Watch metrics for a week (tool invocation rate, timeout rate, LLM tool-selection ratio).
7. Decide whether server-side rerank (#945) is worth doing based on observed behaviour.

## Open questions

None at design time. Any UX polish (icon choice, exact button placement, spacing) is delegated to the implementer to align with existing navigator chrome.

## References

- Issue [#943](https://github.com/sap-tutorials/tutorials-ims/issues/943)
- PR [#944](https://github.com/sap-tutorials/tutorials-ims/pull/944) (Part 1 fix, shipped)
- Parked issues: #945, #946, #947, #948
- Related design docs:
  - `docs/superpowers/specs/2026-05-18-joule-chat-design.md`
  - `docs/superpowers/specs/2026-05-20-hana-vector-rag-design.md`
- Prior art in tree:
  - `srv/lib/kg/joule-tool-find-path.js` — mirror for new tool
  - `srv/lib/chat-orchestrator.js` — tool registry + system prompt
  - `srv/lib/embedding-query.js` — HANA-safe cosine
  - `hugo/static/js/joule.js` — `window.joule.openWithMessage`
  - `hugo-apps/src/advocates/App.joule-handoff.test.ts` — Joule-handoff test pattern
