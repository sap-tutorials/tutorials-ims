# Contextual Joule Help per Step — Design

**Date:** 2026-05-22
**Branch target:** `feature/joule-step-help`
**Layout target:** `hugo/layouts/tutorials/u1-object-page.html` only
**Backend:** none — pure frontend.

## Goal

Add a desktop-only floating action button on every Object Page tutorial that opens the existing Joule chat panel with **step-aware starter chips**. The FAB makes the existing per-step grounding (already attached on every chat send via `readPageContext()`) discoverable as a single-click affordance.

## Non-goals

- No new CAP service, entity, or endpoint.
- No new RAG indexing, embedding, or background tool call.
- No change to `/chat/stream` request shape or `srv/joule-chat-service.js`.
- No mobile FAB (≤960px hides it; the existing shellbar Joule icon remains the mobile entry point, and U18's step-navigator sheet stays uncluttered).
- No legacy `single.html` layout support — Object Page is the active layout for every tutorial since U1, and `single.html` is a 47-line fallback no production tutorial currently renders into.

## Architecture

### Files

| File | Action | Purpose |
|---|---|---|
| `hugo/layouts/partials/joule-step-help.html` | **create** | Renders the FAB shell (button + Joule mark + label). Hidden by default. |
| `hugo/layouts/partials/joule-starters.html` | **modify** | Add a `tutorial-step` array with three template strings containing `{n}` and `{heading}` placeholders. |
| `hugo/layouts/tutorials/u1-object-page.html` | **modify** | Include the new partial near the existing wizard/sheet markup. |
| `hugo/static/js/joule.js` | **modify** | Add `window.joule.openWithStepContext(ctx)`; extend `renderStarters()` with a `tutorial-step` branch; wire the FAB's click handler with current-step derivation. |
| `hugo/static/css/joule.css` | **modify** | FAB position, theme variables, hover state, ≤960px hide rule. |
| `test/smoke/joule-step-fab.test.js` | **create** | One HTTP test asserting the FAB element is present on a deployed tutorial page. |

No backend, no schema, no new service or endpoint.

### Starter templates

Three templates added under `tutorial-step` in `joule-starters.html`:

1. `I'm stuck on Step {n}: {heading}.`
2. `Explain Step {n} in simpler terms.`
3. `What should I check before moving to the next step?`

`{n}` and `{heading}` are substituted client-side at panel open time.

## Behavior

### Visibility gate

The FAB is hidden by default and revealed only when `loadConfig()` resolves with `ChatConfig.enabled === true` — the same gate used by the existing shellbar trigger at `joule.js:578-580`. When chat is disabled, both the shellbar icon and the FAB are removed from the DOM.

### Step detection

Click handler reads `document.querySelector('.tutorial-step.in-view')` (the existing scrollspy state already maintained by the Object Page layout). It extracts:

- `n`: integer from `dataset.step`
- `heading`: trimmed `textContent` of the step's `.step-header-text`
- `slug`: `document.documentElement.dataset.pageSlug`

If no step is currently in view (top of page before any scroll), it falls back to step 1 with whatever heading the first `.tutorial-step` exposes.

### Click flow

```
Click FAB
  → derive {slug, n, heading} from in-view step (or fall back to step 1)
  → window.joule.openWithStepContext({slug, n, heading})
      → existing auth path runs unchanged
          → anon: redirect /login?returnTo=...&joule=open (existing behavior)
          → authed: panel.hidden = false
      → if loadHistory().length > 0: showChat(), renderTranscript() — no surprise reset
      → if no history: showHero(), renderGreeting(), renderStarters({stepContext})
          → starters come from joule-starters.tutorial-step
          → {n} and {heading} substituted into each template
User picks a chip
  → existing send() runs unchanged
  → readPageContext() attaches the same step context the FAB just used (pageContext.slug, .currentStep, .currentStepText, .expandedSteps)
  → /chat/stream POST as today
```

The pre-seeding does not change the `/chat/stream` request shape. The chat backend already receives `pageContext` on every send, so per-step grounding is already wired — the FAB only changes which starters are visible in the hero.

### History precedence

If the user has prior chat history in `sessionStorage`, opening from the FAB shows the existing transcript (no surprise reset). This matches today's behavior. The user can either continue the existing thread or click "Clear chat" in the overflow menu and then click the FAB again to see the step-specific starters.

## Edges & failure modes

| Case | Behavior |
|---|---|
| `ChatConfig.enabled === false` | FAB removed from DOM alongside the shellbar trigger. Single gate. |
| Anonymous user clicks FAB | Same as today: redirect to `/login?returnTo=<path>&joule=open` so panel reopens after login. The `joule=open` query handler already exists at `joule.js:586-591`. |
| Top of page, no `.tutorial-step.in-view` | Fall back to step 1 + first step's heading. |
| Heading text is empty | Substituted templates omit the colon ("I'm stuck on Step 3.") — handled in the substitution helper. |
| Mobile (≤960px) | FAB hidden via CSS. No JS conditional needed. |
| Non-tutorial page | Partial only included from `u1-object-page.html`. List pages, mission pages, search, profile never render the FAB. |
| Dialog/sheet already open (U18 mobile sheet) | Not reachable — FAB is desktop-only, U18 sheet is mobile-only. No interaction. |

## Visual design

- **Position:** `position: fixed; right: 1rem; bottom: 1rem; z-index: 40` — matches U18's z-index so layering is consistent. U18 is mobile-only, so on desktop the only fixed-position element at bottom-right is this FAB.
- **Shape:** rounded pill with the Joule diamond mark (`{{ partial "joule-icon.html" (dict "size" "small") }}`) + visible label "Help with this step". Branded, not a generic question-mark.
- **Theme:** uses existing Joule CSS variables (`--joule-accent`, `--joule-fg`) — automatically theme-aware via the project's `data-theme` and `html.dark` cascade.
- **Hover state:** subtle lift + accent border, matches the existing `.joule-panel__starter` chip hover language.
- **`prefers-reduced-motion`:** no entrance animation; the FAB is rendered in place when `loadConfig()` resolves.
- **Focus ring:** native browser default with `outline-offset: 2px`. Keyboard-reachable.

## Testing

- **Smoke (`test/smoke/joule-step-fab.test.js`):** one HTTP test fetches a deployed tutorial page (`SMOKE_BASE_URL/tutorials/<slug>/`) and asserts the FAB element is present in the rendered HTML.
- **No unit tests:** the change is pure DOM wiring with no business logic. The existing chat unit/smoke coverage is unchanged.
- **Manual browser verification (per CLAUDE.md "test the UI in a browser"):**
  1. Desktop ≥961px: FAB visible at bottom-right on every Object Page tutorial.
  2. Click FAB at top of page → panel opens with starters reading "Step 1: <heading>".
  3. Scroll to step 3 → click FAB → starters now read "Step 3: <heading>".
  4. Pick a starter → message sends → response references step content.
  5. Mobile ≤960px: FAB hidden. U18 step-sheet FAB still works.
  6. Anonymous user: clicking FAB redirects to login, returns and reopens panel.
  7. Disable Joule chat in admin (`ChatSettings.chatEnabled=false`): FAB removed.
  8. Existing chat history: clicking FAB shows transcript, not starters (history takes precedence — documented behavior).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| FAB visually competes with the right-rail navigator on Object Page | Position bottom-right, navigator is top-right rail — separated visually and spatially. |
| User expects auto-send when clicking "I'm stuck on Step 3" — gets starter chip instead | Starter chip text reads as a question template, not a button-action label. The chip click sends. One extra click, but avoids accidental quota burn. Tom approved this tradeoff in brainstorming. |
| Heading substitution breaks on tutorials with markdown in headings | `textContent` strips markup. Verified during manual testing. |
| FAB layer collision with U18's mobile FAB | Eliminated by `display: none` ≤960px. |
| Future layout change away from `u1-object-page.html` | Low risk — Object Page is now the cascade default. If a new layout supersedes it, the partial include moves with the migration. |

## Dependencies

- UI5 Web Components: only `joule-icon.html` (a static SVG), no new web components imported.
- Existing JS: relies on `window.joule.open()` API, `loadConfig()`, `readPageContext()`, `_openImpl()`, `renderStarters()`, `loadHistory()` — all in `hugo/static/js/joule.js`.
- Existing scrollspy: `.tutorial-step.in-view` class maintained by `u1-object-page.html`'s scrollspy at lines 466-497.

## Out of scope

- LLM-generated per-step starters (Approach B from brainstorming — rejected for backend complexity).
- Background `getRelevantSteps` pre-fetch on FAB click (Approach C — rejected as speculative).
- Per-step starter customization in admin UI (no entity, no endpoint, no admin screen).
- Mobile parity beyond the existing shellbar trigger.
- Analytics for FAB click-through rate (can be added later if Tom wants conversion data).
