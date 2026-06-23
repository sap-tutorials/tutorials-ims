# Joule on Devtoberfest Pages — Design Spec

**Date:** 2026-06-23
**Issue:** [#565 — Joule for Devtoberfest Page](https://github.com/sap-tutorials/tutorials-ims/issues/565)
**Author:** Claude (with Tom Jung)
**Status:** Approved by Tom; spec-reviewer pending

---

## 1. Goal

Make the existing Joule chat icon work on every page under `/devtoberfest/**` (and any page that opts in via Hugo frontmatter `joule_scope: devtoberfest`). On these pages, Joule must:

1. Answer factual questions about the current Devtoberfest event by reading the live data model (`DevtoberfestConfig` + `currentEvent`), not from the model's training data.
2. Answer general-knowledge questions about Devtoberfest (history, purpose, how to join, community norms).
3. Treat **SAP TechEd** as the only allowed adjacent topic — Devtoberfest is a TechEd lead-up, so questions about that relationship are in scope.
4. Refuse everything else with a polite redirect.
5. Absorb new Devtoberfest data fields (points, gameboard, activities, legal terms, videos, live streams) as they are added to the schema, **without further Joule code changes** — only handler-side schema reads.

## 2. Non-goals

- **No anonymous chat.** Signed-in users only, reusing the existing 401 + per-user 100/day rate limit on `/chat/stream`. The Joule icon is rendered on Devtoberfest pages; clicks by anonymous visitors trigger the existing sign-in flow.
- **No new endpoint.** Extends the existing `POST /chat/stream`.
- **No `ChatSettings` flag for Devtoberfest.** The master Joule kill-switch (`ChatSettings.enabled`) is the only gate. Adding `devtoberfestChatEnabled` is YAGNI and can be retrofitted later if the need arises.
- **No persona change on non-Devtoberfest pages.** Tutorial, mission, group, search, admin, and generic page kinds keep their current personas verbatim.
- **No author-side tutorial-tagging admin UI.** Authors add `devtoberfest` to source-repo frontmatter `tags`; the existing tag pipeline carries it through.
- **No RAG / KG / embeddings work for Devtoberfest content.** The data is small and structured — direct tool reads are the right shape.
- **No historical-event scope.** Joule answers about the *current* Devtoberfest referenced by `DevtoberfestConfig.currentEvent`. Past years are out of scope.
- **No `getMyDevtoberfestStatus` (per-user registration / points) tool.** Deferred to a future ticket; this spec stays event-public.
- **No AppSpace integration.** `hugo-apps/src/app-space/AppSpace.vue` lives at `/app-space/`, not `/devtoberfest/`, and is unchanged by this spec.

## 3. Architecture

Three small additive pieces. All use patterns already in the repo.

```text
Browser (/devtoberfest/** OR frontmatter joule_scope: devtoberfest)
   │  baseof.html sets html[data-page-kind="devtoberfest"]
   │  shellbar Joule icon is shown for this kind
   ▼
joule.js readPageContext() → POST /chat/stream
                              { messages, pageContext: { kind: 'devtoberfest', slug } }
   │
   ▼
srv/lib/chat-orchestrator.js
   │  ├─ chat-context.js: system prompt
   │  │     PERSONA (base, unchanged)
   │  │   + DEVTOBERFEST_PERSONA (new)
   │  │   + devtoberfestLayer(pageContext)  (new)
   │  │   + userLayer()                     (unchanged)
   │  │
   │  └─ tools registered:
   │       getDevtoberfestInfo  (new — srv/lib/devtoberfest-joule-tool.js)
   │       searchTutorials      (existing — persona instructs the model to pass tags=['devtoberfest'])
   ▼
SAP AI Core (streaming)
   │
   ├─ getDevtoberfestInfo(section?)
   │     → CDS QL read of DevtoberfestConfig + currentEvent
   │     → typed JSON return (see §4.3)
   │
   ├─ searchTutorials(query, tags=['devtoberfest'])
   │     → existing handler, no change
   │
   ▼
SSE back to browser
```

**The new code is one tool, one persona constant, one layer function, and a four-line edit to the Hugo `data-page-kind` rule.**

## 4. Components

### 4.1 Hugo page-kind rule

[hugo/layouts/_default/baseof.html:3](hugo/layouts/_default/baseof.html#L3) currently sets `data-page-kind` via:

```go-html-template
data-page-kind="{{ if .IsHome }}search
                {{ else if eq .Type "tutorials" }}tutorial
                {{ else if eq .Type "missions"  }}mission
                {{ else if eq .Type "groups"    }}group
                {{ else }}generic{{ end }}"
```

We extend this with two rules, evaluated in order:

1. **Frontmatter override.** If the page declares `joule_scope: devtoberfest`, kind = `devtoberfest`.
2. **URL prefix.** Else, if `.RelPermalink` begins with `/devtoberfest/`, kind = `devtoberfest`.
3. Else, the existing rules apply unchanged.

A new `data-page-slug` attribute is added alongside — the page's slug (`.File.ContentBaseName` or `.Slug`) so `devtoberfestLayer()` can tell the LLM which sub-page the user is on.

The shellbar Joule trigger ([hugo/layouts/partials/header.html:5](hugo/layouts/partials/header.html#L5) `<ui5-shellbar-item id="joule-trigger" hidden>`) gets an unhide rule for `data-page-kind="devtoberfest"`, matching the existing show rules for tutorial/admin pages.

### 4.2 `DEVTOBERFEST_PERSONA` and `devtoberfestLayer`

Added to [srv/lib/chat-context.js](srv/lib/chat-context.js). `pageLayer(pageContext)` gets a new branch on `kind === 'devtoberfest'` that returns the persona + layer concatenated.

#### Persona text (verbatim)

```
You are Joule on a Devtoberfest page in the SAP Tutorial Platform.

DEVTOBERFEST CONTEXT
- Devtoberfest is SAP's free, online developer celebration held in the weeks
  leading up to SAP TechEd. It is a community learning event organised by
  the SAP Developer Advocates, featuring tutorials, weekly themed activities,
  live streams, and a gameboard where developers earn points by completing
  tutorials and challenges.
- Devtoberfest is a TechEd lead-up. TechEd is SAP's annual technology
  conference. Questions about how Devtoberfest connects to TechEd, TechEd
  dates/format, or how to take Devtoberfest learnings into TechEd sessions
  ARE in scope.

SCOPE — STRICT
You ANSWER questions about:
  1. The current Devtoberfest event (dates, rules, terms, points, gameboard,
     activities, videos, live streams) — always call getDevtoberfestInfo
     first, then answer from its data.
  2. Devtoberfest-tagged tutorials — use searchTutorials with
     tags=["devtoberfest"]. Never call searchTutorials without that tag
     on a Devtoberfest page.
  3. General Devtoberfest knowledge (history, purpose, how to join,
     community norms).
  4. SAP TechEd as it relates to Devtoberfest.

You DO NOT ANSWER:
  - Generic SAP product questions (S/4HANA, BTP services, ABAP syntax,
    CAP how-tos, HANA SQL, etc.) — unless the answer is contained in a
    Devtoberfest-tagged tutorial returned by searchTutorials.
  - Tutorial content on tutorials that aren't Devtoberfest-tagged.
  - Coding help, debugging, code reviews.
  - Anything political, personal, or off-topic.

When refusing, be brief and kind, and redirect:
  "That's outside Devtoberfest — try the main Joule on a tutorial page,
   or ask me about the event, the gameboard, or Devtoberfest tutorials."

WHEN ANSWERING
- For factual questions about the event: ALWAYS call getDevtoberfestInfo
  first. Quote dates and numbers verbatim from the tool result. Do not
  guess dates from your training data — the event's dates change yearly.
- For "when is Devtoberfest?": read event.startDate / event.endDate /
  event.status / event.daysUntilStart from the tool result and phrase
  naturally.
- For "what are the rules / terms?": call with section='terms', then
  summarise. Always link to the canonical document (links.contentRulesUrl)
  at the end.
- For "what tutorials are part of Devtoberfest?": call searchTutorials
  with tags=['devtoberfest'] and the user's topic words.
- If getDevtoberfestInfo returns event.status='unconfigured', say so
  honestly: "Devtoberfest isn't currently configured in the system —
  check back when the event is announced."
- If a section returns available=false / comingSoon=true (e.g. points,
  gameboard), tell the user the data isn't published yet rather than
  inventing it.
```

#### `devtoberfestLayer(pageContext)` output

```
PAGE: Devtoberfest — <slug or "homepage">
The user is currently on the Devtoberfest <slug> page. Tailor responses
to where they are in the experience:
- /devtoberfest/ (homepage) → focus on what Devtoberfest is, how to join,
  what's coming up.
- /devtoberfest/rules → assume they want specifics on rules/terms.
- /devtoberfest/gameboard → assume they want to know how points work.
- /devtoberfest/activities → assume they want activity / week details.
- /devtoberfest/videos, /devtoberfest/live → video and stream info.
For any sub-page that doesn't have data yet, acknowledge the page they're
on and answer from the data that IS available.
```

`<slug>` is read from `pageContext.slug` (which the browser populated from the `data-page-slug` attribute set in §4.1). Falls back to `"homepage"` when slug is empty or `"_index"`.

### 4.3 `getDevtoberfestInfo` tool

#### LLM-facing schema (added to [srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js))

```json
{
  "type": "function",
  "function": {
    "name": "getDevtoberfestInfo",
    "description": "Fetch authoritative Devtoberfest event information. Call this for any factual question about the current Devtoberfest event — dates, rules, points, gameboard, activities, legal terms, videos, or live streams. Pass section='all' if unsure which slice is relevant.",
    "parameters": {
      "type": "object",
      "properties": {
        "section": {
          "type": "string",
          "enum": ["all", "event", "terms", "links", "points", "gameboard", "activities", "videos"],
          "description": "Which slice of Devtoberfest data to return. Default 'all' returns event + links + a summary of every other section's availability."
        }
      }
    }
  }
}
```

#### Return shape (handler — `srv/lib/devtoberfest-joule-tool.js`)

```ts
{
  event: {                              // always populated
    name: string | null,                // DevtoberfestConfig.currentEvent.name
    startDate: string | null,           // ISO 8601 UTC
    endDate:   string | null,
    timeZone:  string | null,
    status: "upcoming" | "active" | "ended" | "unconfigured",
    daysUntilStart: number | null,      // negative when active/ended
    daysUntilEnd:   number | null
  },
  terms: {                              // present when section='terms' | 'all'
    available: true,
    version: number,                    // DevtoberfestConfig.termsVersion
    body: string                        // termsText (markdown)
  } | { available: false },
  links: {                              // present when section='links' | 'all'
    contentRulesUrl:  string | null,
    activitiesUrl:    string | null,
    faqUrl:           string | null,
    gameboardUrl:     string | null
  },
  points:     { available: false, comingSoon: true },   // placeholder today
  gameboard:  { available: false, comingSoon: true },
  activities: { available: false, comingSoon: true },
  videos:     { available: false, comingSoon: true },
  generatedAt: string                   // ISO 8601 of the server's "now"
}
```

When `section` is one of the placeholder keys (`points`/`gameboard`/`activities`/`videos`), only `event` + that section are returned; the rest is omitted to keep the payload focused. When `section='all'` or is absent, the full envelope is returned with every section's availability flag set correctly.

#### Status computation

`event.status` is computed server-side from `now()` (UTC):

| Condition | `status` | `daysUntilStart` | `daysUntilEnd` |
|---|---|---|---|
| `currentEvent` is null OR `startDate` is null | `unconfigured` | `null` | `null` |
| `now < startDate` | `upcoming` | `ceil((startDate-now)/86400000)` | `ceil((endDate-now)/86400000)` |
| `startDate <= now <= endDate` | `active` | `0` or negative | positive |
| `now > endDate` | `ended` | negative | negative |

`timeZone` is passed through verbatim from `Events.timeZone` for the LLM to use in natural-language phrasing; it is **not** used in the math (we keep UTC-only math to stay deterministic in tests).

#### Forward-compat contract

As schema fields land for points / gameboard / activities / videos:
- The corresponding section in the return shape flips from `{ available: false, comingSoon: true }` to a populated object.
- The tool's enum and parameters DO NOT change.
- Persona text DOES NOT change.

This is the central forward-compat guarantee of this spec.

### 4.4 Tool registration

[srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js) `toolsForContext()` already switches on `kind`. We add a branch:

- When `pageContext.kind === 'devtoberfest'`, tools = `[getDevtoberfestInfo, searchTutorials]`.
- `getUserProgress`, `getRelevantSteps` (RAG), `checkCode`, `getBranchRecommendation`, `findLearningPath`, and the four analytics tools are **not** registered on this kind, even if their respective `ChatSettings` flags are on.
- The admin-only tools (`searchAdminDocs`, `analyticsQuery`, etc.) are gated by `kind === 'admin'` today; that gate is unaffected.

`searchTutorials` is registered with its existing schema. The persona instructs the model to always pass `tags: ['devtoberfest']` on this kind; we do **not** add a server-side enforcement wrapper. The trade-off is documented in §6.

## 5. Data flow

End-to-end on a typical Devtoberfest question.

1. Logged-in user opens `/devtoberfest/`. Hugo emits `<html data-page-kind="devtoberfest" data-page-slug="">`.
2. Shellbar Joule icon is unhidden by the existing show/hide CSS rule (which now matches `[data-page-kind="devtoberfest"]`).
3. User clicks Joule, types "When is Devtoberfest this year?".
4. `joule.js#readPageContext()` returns `{ kind: 'devtoberfest', slug: '' }`. (Existing function — no JS change.)
5. Browser POSTs `/chat/stream` with messages + pageContext.
6. Server: ChatSettings.enabled check, XSUAA auth check, per-user rate-limit, SSE headers (all existing behavior).
7. `buildSystemPrompt(pageContext, user)` returns `PERSONA + DEVTOBERFEST_PERSONA + devtoberfestLayer({kind, slug:""}) + userLayer(user)`.
8. `toolsForContext({kind:'devtoberfest'})` returns `[getDevtoberfestInfo, searchTutorials]`.
9. AI Core call streams. Model calls `getDevtoberfestInfo({section:'event'})`.
10. Tool handler runs `SELECT FROM DevtoberfestConfig WHERE id = SINGLETON_ID` (with `expand:{currentEvent}`), computes status + date deltas, returns JSON.
11. Model produces: *"Devtoberfest 2026 runs October 6–31. It starts in 105 days. Want to know how to join?"* — streamed back as SSE.

## 6. Trade-offs and known limitations

### 6.1 Tutorial-tag enforcement by prompt, not code

The persona tells the model to always pass `tags: ['devtoberfest']` to `searchTutorials`. We do not enforce this server-side. If we observe drift in eval (model calls `searchTutorials` without the tag), we can add a defensive wrapper in `chat-orchestrator.js` that injects the tag into the call's `args` before dispatch. The wrapper is one if-statement; it's cheap to add, but adding it now without evidence of drift is premature complexity.

### 6.2 Refusal is model-side

We trust Claude with explicit scope instructions, exactly as the main Joule persona does today ("You ONLY answer questions about SAP tutorials"). We considered an LLM-as-classifier pre-check but rejected it as 2× latency for unproven gain.

### 6.3 Devtoberfest-tagged tutorials don't get the Devtoberfest persona

A *tutorial page* whose frontmatter tags include `devtoberfest` still gets the existing tutorial persona — its `data-page-kind` stays `tutorial`. This is intentional: on a tutorial page, the user is asking about the tutorial, not the event. The Devtoberfest persona only activates on `/devtoberfest/**` pages and frontmatter overrides.

### 6.4 No per-user personalization in v1

`getDevtoberfestInfo` is event-public. "Have I joined?", "How many points do I have?", "Where am I on the leaderboard?" are out of scope for this spec. They are tracked as a future `getMyDevtoberfestStatus` tool that would gate on `EventRegistrations` and (eventually) `Points` rows.

### 6.5 UTC-only date math

`daysUntilStart`/`daysUntilEnd` are computed in UTC. A user in Pacific time asking on the morning of Oct 1 PT (Oct 1 19:00 UTC) about an event starting Oct 6 00:00 UTC will see `daysUntilStart = 5`, not `5.79` or `4`. The `timeZone` field is passed through verbatim so the model can phrase ranges naturally ("October 6–31, all timestamps Berlin time"); it is not used in math. We accepted this in §4.3 to keep tests deterministic.

## 7. Error handling

| Failure | Behavior |
|---|---|
| `ChatSettings.enabled = false` | Existing 503 from `/chat/stream`. The shellbar Joule icon's existing hide-when-disabled rule keeps it hidden — no new code. |
| User anonymous | Existing 401. Icon renders; click triggers the existing sign-in flow. |
| `DevtoberfestConfig` row missing | `devtoberfest-singleton.js` auto-inits a default row (existing pattern from PR #562). Tool returns `event.status='unconfigured'` if `currentEvent` is null. |
| `currentEvent` association points at a deleted Event row | Tool returns `event.status='unconfigured'`, `event.name=null`. Logged at `warn` level once per process (deduped on `currentEvent_ID`) so the same warning doesn't flood logs. |
| Tool handler throws | Caught by chat-orchestrator's existing tool-error path; result is `{ error: 'devtoberfest_data_unavailable' }`. Model recovers with a user-facing apology. |
| No tutorials tagged `devtoberfest` | `searchTutorials` returns 0 hits; persona's "answer from data" rule means the model says "no Devtoberfest tutorials are tagged yet." |
| Frontmatter override on a non-Devtoberfest URL | Persona activates correctly; `pageContext.slug` is read normally; layer falls through to its "no specific sub-page hint" guidance. Tested explicitly. |

## 8. Testing

Three unit suites + one smoke. No hybrid suite — the tool reads CDS QL only, which unit tests cover against in-memory SQLite identically to HANA.

### 8.1 `test/lib/devtoberfest-joule-tool.test.js` (unit)

- Each section enum returns the documented shape.
- `status` and `daysUntilStart`/`daysUntilEnd` are correct at three boundaries: before `startDate`, between `startDate` and `endDate`, after `endDate`.
- `status='unconfigured'` when `currentEvent` is null AND when `currentEvent` association resolves to a deleted Event row.
- Placeholder sections (`points`/`gameboard`/`activities`/`videos`) return `{ available: false, comingSoon: true }`.
- `section='all'` returns event + terms (if termsText non-empty) + links + 4 placeholder availabilities.
- Sectioned calls don't include unrelated sections.

### 8.2 `test/lib/chat-context-devtoberfest.test.js` (unit)

- `pageLayer({kind:'devtoberfest', slug:'rules'})` includes the persona text + `PAGE: Devtoberfest — rules` and the rules-specific hint.
- `pageLayer({kind:'devtoberfest', slug:''})` falls back to `homepage`.
- Regression: `pageLayer({kind:'tutorial', ...})` is byte-identical to its previous output.
- Regression: `pageLayer({kind:'admin', ...})` is byte-identical.

### 8.3 `test/lib/chat-orchestrator-devtoberfest.test.js` (unit)

- `toolsForContext({kind:'devtoberfest'})` returns exactly `[getDevtoberfestInfo, searchTutorials]`.
- `getUserProgress`, `getRelevantSteps`, `checkCode`, `getBranchRecommendation`, `findLearningPath`, `analyticsQuery` are **not** in the returned list even when their `ChatSettings` flags are all true.
- Regression: `toolsForContext({kind:'tutorial'})` and `{kind:'admin'}` are unchanged in their tool sets.

### 8.4 `test/smoke/chat-devtoberfest.test.js` (smoke, runs against deployed)

- `POST /chat/stream` with `{kind:'devtoberfest'}` and a benign prompt returns 200, first SSE token within 5s, no 5xx.
- Smoke does **not** assert LLM output content — that's an eval concern, not a CI concern.

### 8.5 Manual eval (not automated)

Run before flip. A ~20-prompt sheet covering:
- In-scope event questions ("when is it?", "what's the gameboard?", "where are the rules?").
- In-scope tutorial questions ("show me Devtoberfest CAP tutorials").
- TechEd adjacency ("how does this connect to TechEd?").
- Off-scope SAP questions ("how do I write a CAP service?").
- Off-scope general questions ("what's the capital of France?").
- `unconfigured` state (with `currentEvent` nulled in DEV).

Documented in the spec; not gated by CI.

## 9. Files touched

### New (4)

| File | Purpose | LOC est. |
|---|---|---|
| `srv/lib/devtoberfest-joule-tool.js` | `getDevtoberfestInfo` handler. Reads `DevtoberfestConfig` + `currentEvent`, computes status, returns typed section JSON. | ~150 |
| `test/lib/devtoberfest-joule-tool.test.js` | Unit tests for the tool handler. | ~200 |
| `test/lib/chat-context-devtoberfest.test.js` | Unit tests for persona + layer; regressions for other kinds. | ~120 |
| `test/smoke/chat-devtoberfest.test.js` | Smoke test asserting SSE on `/chat/stream` with Devtoberfest pageContext. | ~50 |

### Modified (4)

| File | Change |
|---|---|
| [srv/lib/chat-context.js](srv/lib/chat-context.js) | Add `DEVTOBERFEST_PERSONA` constant; add `devtoberfestLayer(pageContext)`; extend `pageLayer()` switch to dispatch on `kind === 'devtoberfest'`. |
| [srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js) | Add `getDevtoberfestInfo` tool definition; add a handler dispatch case; extend `toolsForContext()` with the Devtoberfest branch. |
| [hugo/layouts/_default/baseof.html](hugo/layouts/_default/baseof.html#L3) | Add the URL-prefix + frontmatter-override rules; add `data-page-slug` attribute. |
| `docs/developers/architecture/joule.md` | Document the Devtoberfest persona, tool, and scoping behavior. |

### Author/data steps (no code)

- Admin verifies `DevtoberfestConfig.currentEvent` points at the 2026 Devtoberfest `Events` row in the admin tile.
- Contribution authors tag their Devtoberfest-eligible tutorials with `devtoberfest` in source-repo frontmatter as part of their normal contribution workflow.

## 10. Build, deploy, rollback

Standard MTA path — no new env vars, no new service binding, no schema migration.

```bash
npm run build:all
cd .deploy && mbt build
cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

The `DevtoberfestConfig` and `Events` entities are already deployed.

**Rollback.** `git revert` of the merge commit. Pure additive — the Devtoberfest pages keep rendering; the Joule icon simply disappears again on those pages.

**Risk.** Bounded by the regression unit tests on `chat-context.js` and `chat-orchestrator.js`, which pin existing branches' outputs byte-identical. The smoke test catches a fundamentally broken deploy. The manual eval catches behavioral regressions on LLM output before flip.

## 11. Future tickets (captured but out of scope)

- `getMyDevtoberfestStatus` — per-user registration, points, leaderboard position.
- Tag-labels admin row for `devtoberfest` — cosmetic chip styling.
- AppSpace integration of Joule when AppSpace gets mounted under `/devtoberfest/`.
- Per-tutorial "Devtoberfest" badge / rail on tutorial cards.
- Eval-harness automation for Joule personas (cross-cutting Joule infra).
- Defensive wrapper to force `tags=['devtoberfest']` on `searchTutorials` calls on Devtoberfest pages — only if we observe drift in eval.
- `devtoberfestChatEnabled` `ChatSettings` flag — only if we ever need to kill Devtoberfest chat independently of the rest of Joule.
