# Preview API — Validation Question Support (F-8) — Design Spec

**Status:** Approved 2026-06-26
**Issue:** [sap-tutorials/tutorials-ims#655](https://github.com/sap-tutorials/tutorials-ims/issues/655)
**Supersedes:** Out-of-scope section of the original Preview API design ([2026-05-23-vscode-author-preview-design.md](2026-05-23-vscode-author-preview-design.md)) — promotes follow-up F-8 (validation question support) into a fully scoped change.

---

## Background

The original Preview API (`POST /preview/render` on `tutorials-srv-qa`) ships a fully-rendered Object Page from raw markdown but deliberately bypasses the parser pipeline's `rules.vr` fetch and gates the entire validation widget off (`{{ if not site.Params.previewMode }}` around `validation.js` in [hugo/layouts/tutorials/u1-object-page.html:438](../../hugo/layouts/tutorials/u1-object-page.html)). As a result:

1. Validation questions never appear in the preview (`step.validation == null` after compose).
2. Even the static mount divs that survive are inert — no Vue island hydrates them.
3. AI-involved features (free-text grading, AI-authored quizzes, code-check, Joule step-help) likewise don't render anything in preview.

Riley Rainey raised both gaps in #655 ahead of a Sage-extension review meeting. This spec closes them.

## Confirmed decisions (Tom, 2026-06-26)

1. **Scope:** Static render of questions **+** interactive Vue widget **+** global "Reset all answers" affordance. AI-grader live calls and per-question reset are deferred. *(Option B in brainstorm Q1.)*
2. **Payload contract:** Extend `{ markdown }` → `{ markdown, rulesVr? }`. Optional sibling field, fully backward-compatible with existing callers. *(Option A in Q2.)*
3. **Widget gate:** Remove the Hugo `previewMode` gate around `validation.js`; teach the widget about preview via a `data-preview="true"` data-attribute emitted by the step shortcode. *(Option C in Q3.)*
4. **Reset UX:** A single preview-only banner partial at the top of the page with "Reset all answers" + "Reveal AI rules" controls. Window-level CustomEvents wire it to the widgets. *(Option B in Q4.)*
5. **AI-involved features:** Render a uniform static placeholder notice **+** the relevant `rules.vr` block verbatim for every AI-touched section (free-text AI grading, `[AUTOAUTHOR_*]` quizzes, `[CODECHECK_N]` specs, Joule step-help). No AI calls from preview. *(Tom's clarification on Q5 — applied uniformly across all four AI subsystems.)*

## Architecture

### Request contract

```
POST /preview/render
Authorization: Bearer <JWT with Tutorial.Author scope>
Content-Type: application/json
Body: { "markdown": "<string>", "rulesVr": "<string, optional>" }
Limit: 1 MB combined
```

- `rulesVr` omitted or empty string → behavior identical to today.
- Both fields validated as `typeof === 'string'`; non-string `rulesVr` → 400.
- Existing auth + semaphore + always-200-with-error-HTML contract unchanged.

### Data flow per request

```
[VSCode extension]
    │ reads .md + sibling rules.vr from disk
    ▼
POST /preview/render  { markdown, rulesVr? }
    │
    ▼
[srv-qa Express handler]                        srv-qa/server.js (modify)
    │ requireXsuaaScope('Tutorial.Author')
    │ json body limit 1mb
    │ semaphore acquire
    ▼
[Preview renderer]                              srv-qa/preview-renderer.js (modify)
    │ composeTutorial(markdown, { rulesVr, ... })
    │   ↳ parsers.bundle.mjs (re-bundle):
    │     - if rulesVr supplied: parseRulesVrEnriched(rulesVr)
    │     - merge validation + codeCheck + AI-authored into composed.steps
    │     - emit per-step `aiInvolved` flag
    │   ↳ renderHugoFrontmatter — passes blocks through
    ▼
[Hugo render — preview-site]
    │ site.Params.previewMode = true
    │ shortcode tutorial-step.html: emits
    │   <div class="step-validation-mount"
    │     data-step="N"
    │     data-preview="true"
    │     data-ai-involved="false|true">
    │ baseof.html: renders preview-banner partial when previewMode
    │ u1-object-page.html: validation.js gate REMOVED
    ▼
[VSCode webview]
    │ /js/preview-banner.js auto-resets prefix on load
    │ /js/validation.js hydrates with data-preview="true"
    │ Widget self-governs:
    │   - AI questions: <PreviewAINotice> with rules.vr block (no input)
    │   - Non-AI questions: live interactive grading against rules.vr
    │   - Listens for `tutorial-preview:reset-answers` event
```

### Component contracts

**`composeTutorial(markdown, opts)` — extended**

```js
composeTutorial(markdown, {
  repo, branch, slug, target, rewriteImages,
  rulesVr,  // NEW: optional string. When set + parses, merges into composed.steps.
})
// Returns: { ...existing, steps: [{ ..., validation?, codeCheck?, aiInvolved? }] }
```

- `rulesVr` omitted → current behavior preserved.
- `rulesVr` malformed → throw caught upstream → 200 + error HTML (existing failure path).
- `aiInvolved` is a step-level boolean: `true` if step has free-text `aiGrading: true`, AI-authored questions, OR a `[CODECHECK_N]` block. Drives Hugo + widget rendering.

**Preview banner ↔ widget events** (window-level CustomEvents, `tutorial-preview:` namespace)

- `tutorial-preview:reset-answers` — emitted by banner Reset button + automatically on each preview load. Widget clears local state.
- `tutorial-preview:reveal-ai-rules` — `detail: { on: boolean }` — toggles `<pre>` block visibility inside `<PreviewAINotice>`.

**Storage isolation**

- All preview localStorage keys live under `tutorial-validation-__preview__-*` (synthetic preview slug).
- Reset wipes only this prefix — never touches a separately-tested live tutorial's state.
- `__preview__` slug never collides with real tutorial slugs (underscores aren't valid in real slugs; enforced by canonical-lowercasing + slug-uniqueness constraint).

### File-level changes

**Modify (server-side):**

| File | Change |
|---|---|
| `srv-qa/server.js` | Add `rulesVr` to body validation (`typeof === 'string'` or undefined). Pass through to `renderPreview()`. |
| `srv-qa/preview-renderer.js` | Accept `{ markdown, rulesVr }`. Pass `rulesVr` into `composeTutorial`. |
| `srv-qa/lib/parsers.bundle.mjs` | Re-bundle to include `parseRulesVrEnriched`. `composeTutorial` accepts optional `rulesVr`; when set, parses + merges into steps. Bundler config explicitly excludes `fetchRulesVr` / `fetchGitHubMeta`. |
| `test/srv-qa/preview-renderer.test.js` | New tests (see Testing). |

**Modify (Hugo layouts — all gated on `previewMode`; prod untouched):**

| File | Change |
|---|---|
| `hugo/layouts/tutorials/u1-object-page.html` (~L438) | Remove `{{ if not site.Params.previewMode }}` wrapper around `<script src="/js/validation.js">`. |
| `hugo/layouts/shortcodes/tutorial-step.html` (~L17) | Emit `data-preview="true" data-ai-involved="…"` on `.step-validation-mount` when `previewMode`. |
| `hugo/layouts/partials/preview-banner.html` **(NEW)** | Sticky top banner: `[Preview mode] · [Reset all answers] · [Reveal AI rules: toggle]`. Renders only when `previewMode`. The "Reveal AI rules" toggle is hidden when `<body data-has-ai="false">`. |
| `hugo/layouts/_default/baseof.html` | Render `preview-banner.html` when `previewMode`. Emit `<body data-has-ai="…">` derived from any step's `aiInvolved` flag. Add `<script src="/js/preview-banner.js" defer>` gated on `previewMode`. |
| `hugo/layouts/partials/codecheck-mount.html` | When `previewMode` and step has codeCheck spec: render `PreviewAINotice` mount with `data-rules-block` attribute carrying the source `[CODECHECK_N]` block. Existing prod path unchanged. |
| `hugo/layouts/partials/joule-step-help.html` | When `previewMode`: render an inline static notice "Joule step help available after publish" instead of the FAB. |

**Modify (Vue validation widget):**

| File | Change |
|---|---|
| `hugo-apps/src/validation/Validation.vue` | Read `data-preview` + `data-ai-involved` attrs on mount. If `data-preview="true"`: (a) suppress `/feedback/submit` and any other network calls; (b) listen for `tutorial-preview:reset-answers` on `window`, clear local state on receipt; (c) if `data-ai-involved="true"` (free-text AI / AI-authored), replace input UI with `<PreviewAINotice>`. |
| `hugo-apps/src/validation/PreviewAINotice.vue` **(NEW)** | Renders the static "AI features can only be fully previewed once deployed" notice + a `<pre>` block with the source rules.vr snippet (passed via prop). `<pre>` visibility toggled by listening for `tutorial-preview:reveal-ai-rules`. |
| `hugo-apps/src/validation/preview-banner.ts` **(NEW)** | Entry script wiring banner button events: Reset → wipe `tutorial-validation-__preview__-*` localStorage keys + emit `tutorial-preview:reset-answers`. Reveal toggle → emit `tutorial-preview:reveal-ai-rules` with `{ on }`. On load: auto-emits reset to clear stale state from prior preview sessions. |
| `hugo-apps/vite.config.ts` | Add `preview-banner` entry point. |

### Error handling

| Scenario | Behavior |
|---|---|
| `rulesVr` omitted | Existing behavior — no validation widgets, no AI notices. Banner Reset is a no-op. |
| `rulesVr === ""` | Identical to omitted. No parse attempt. |
| `rulesVr` references step numbers absent from markdown | `parseRulesVrEnriched` already drops unmatched blocks silently; log to stderr for visibility but don't fail the render. |
| `rulesVr` malformed (parser throws) | 200 + error HTML showing parse error + first 4 stack frames (matches markdown parse-error pattern). Frontmatter chrome still renders. |
| Combined body > 1 MB | Express body-parser → 413 (existing path). |
| Reset clicked with zero widgets | Banner button fires event; widgets that exist no-op; localStorage prefix sweep no-ops. Idempotent. |
| Reveal toggled with zero AI on page | Toggle hidden — `<body data-has-ai="false">` driven by Hugo. |
| Author opens a different tutorial in same session | Auto-reset on load wipes prior `__preview__-*` state before widgets hydrate. No cross-contamination. |

### Why these abstractions

- **`composeTutorial` opt-in arg** — preview is the only consumer of the new `rulesVr` arg; the existing fetch-tutorials path keeps its own merge after a separate `parseRulesVrEnriched` call. One API, two callers.
- **`data-preview` + `data-ai-involved` as the widget's only inputs** — the widget shouldn't have to know which Hugo project rendered it. Two boolean attrs suffice.
- **Banner as a separate Vite entry, not part of validation.js** — banner needs to load and run *before* widgets hydrate (so auto-reset clears state first). Smaller, focused bundle; separate script tag with `defer` ordering.
- **`tutorial-preview:` event namespace** — reserved for future preview-only signaling (e.g. branching simulation, language switch). Prevents collision with feature events.

### Open implementation tactic — rules.vr block transport to `<PreviewAINotice>`

The block text (especially `[CODECHECK_N]` reference solutions) can be sizeable and contains characters that double-escape awkwardly through HTML attributes. The planning step should pick between:

1. **Attribute** (`data-rules-block="…"`) — simple, but uncomfortable for multi-line / code-heavy specs.
2. **Sibling `<script type="application/json">`** with the block as a JSON string — escape semantics are predictable; the widget reads it on mount. Recommended.
3. **Server-rendered Hugo child element** carrying the block as pre-formatted text inside the mount div — widget reads `innerHTML` of the slot.

This is a planning-time call; functionally any of the three meets the contract.

## Security

Unchanged from the original Preview API spec:

- **No DB access** during render.
- **No external HTTP calls** during render — `parsers.bundle.mjs` re-bundle explicitly excludes fetch functions; preview-renderer test asserts zero `fetch` calls via mock.
- **No AI Core quota burn** — all AI-involved sections render static notices; no live grader calls.
- **No markdown / rules.vr body in logs.**
- **Image rewriting still OFF.**
- **Tmp-dir isolation unchanged.**

## Testing strategy

### Unit (`unit` vitest project)

`test/srv-qa/preview-renderer.test.js` — extend existing file:

- `composeTutorial` called with `rulesVr` → matching steps have `validation` / `codeCheck` populated; non-matching steps clean.
- `composeTutorial` called without `rulesVr` → current behavior preserved (no validation blocks).
- Empty-string `rulesVr` → same as omitted.
- Malformed `rulesVr` → renderer returns 200 + error HTML; tmp-dir cleanup runs.
- `aiInvolved` flag set on steps with `aiGrading: true`, AI-authored, OR codecheck spec.
- Mocked-fetch assertion: zero outbound HTTP calls during render.

`test/srv-qa/server.test.js`:

- Body `{ markdown, rulesVr: 123 }` → 400.
- Body `{ markdown, rulesVr: "" }` → 200 (treated as omitted).
- Body `{ markdown, rulesVr: <valid string> }` → 200 text/html.

`hugo-apps/src/validation/Validation.preview.test.ts` **(NEW)**:

- Widget reads `data-preview="true"` and skips network calls (mocked fetch asserts zero calls).
- Listens for `tutorial-preview:reset-answers`, clears persisted state.
- AI-involved question renders `<PreviewAINotice>` (not the input field).

`hugo-apps/src/validation/preview-banner.test.ts` **(NEW)**:

- Reset button wipes `tutorial-validation-__preview__-*` keys + emits event.
- Reveal toggle emits `tutorial-preview:reveal-ai-rules` with correct `on` state.
- Auto-reset on load: banner script clears prefix keys on initialization.

### Hybrid-qa

None. Preview is stateless.

### Smoke (`smoke` vitest project, gated on `SRV_URL_QA` + `SMOKE_QA_TOKEN`)

Add to `test/smoke/qa-routes.test.ts`:

- `POST /preview/render` with `{ markdown, rulesVr }` containing `[VALIDATION_1]` → 200, response HTML contains the question text.
- `POST /preview/render` with `{ markdown, rulesVr }` containing `[AUTOAUTHOR_*]` → 200, response HTML contains `<PreviewAINotice>` text.
- `POST /preview/render` with malformed rulesVr → 200, body contains parse error message.
- `POST /preview/render` with `markdown` only → 200; preview banner still renders (since `previewMode` is on) but the "Reveal AI rules" toggle is hidden (no AI on page); no validation widgets.

### Accessibility

- Banner: `role="region"` + accessible-name `"Tutorial preview controls"`.
- Reset button: `<ui5-button>` with text label.
- Reveal toggle: `<ui5-switch>` with `accessible-name`.
- `PreviewAINotice`: `role="note"` + heading + `<pre>` with WCAG-AA contrast.

## Operational concerns

- **Memory:** No change. Re-bundled parsers add ~3 KB to the srv-qa slug; no runtime impact.
- **Slug bloat:** Negligible (~3 KB).
- **Concurrency:** Unchanged — still 4 concurrent renders × ~500ms.
- **Logging:** Add `{ event: 'preview.render', status, ms, bytes, hasRulesVr: boolean }` field. Body content never logged.
- **Hugo version pinning:** Unchanged.

## Rollout

1. Land code on `feature/655-preview-validation`. Subagent review + PR per [feedback-pr-over-direct-merge].
2. CI deploy refreshes `tutorials-srv-qa` only. No schema impact, no `tutorials-srv` (prod) impact.
3. Smoke tests run automatically post-deploy.
4. Sage review meeting — demo against deployed srv-qa with a representative tutorial covering hand-authored `[VALIDATION_N]`, `[AUTOAUTHOR_*]`, and `[CODECHECK_N]` blocks.
5. VSCode extension team picks up the contract change (`rulesVr` field) when convenient — existing `{ markdown }`-only callers keep working, so no synchronized rollout required.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Re-bundling `parsers.bundle.mjs` accidentally pulls GitHub-fetch logic into srv-qa | Medium | Bundler config explicitly excludes `fetchRulesVr` / `fetchGitHubMeta`. Preview-renderer test asserts zero outbound HTTP. |
| Validation widget breaks in prod due to `data-preview` branch | Low | `data-preview` is opt-in (absent in prod); widget defaults to current behavior. Unit test guards this. |
| Preview banner CSS bleed into prod | Zero | Banner partial only rendered when `previewMode` is on. |
| `tutorial-preview:reset-answers` event name collision | Low | Reserved namespace `tutorial-preview:` for preview-only events. |
| `__preview__` slug collides with a real tutorial | Zero | Underscores aren't valid in real slugs (kebab-case + canonical-lowercasing enforced). |
| `rules.vr` step references don't match markdown | Medium | `parseRulesVrEnriched` already drops silently; log a warning for visibility. |

## Acceptance criteria

- `POST /preview/render` accepts `{ markdown, rulesVr? }` and merges rules.vr blocks into the rendered HTML when present.
- Hand-authored `[VALIDATION_N]` questions render with full Vue interactivity in preview — author can answer, see grading, and reset.
- Free-text `aiGrading: true` questions render a static notice + the source rules.vr block, no input field, no network calls.
- `[AUTOAUTHOR_*]` blocks render a static notice + the source directive.
- `[CODECHECK_N]` blocks render a static notice + the source spec instead of the interactive code-check UI.
- Joule step-help renders a static notice instead of the FAB in preview.
- Preview banner shows "Reset all answers" and (when AI is on the page) "Reveal AI rules" controls.
- Reset wipes only `tutorial-validation-__preview__-*` keys + clears widget state.
- Auto-reset fires on each preview load (no stale state across edits).
- No DB access, no outbound HTTP, no AI Core quota burn during preview render.
- Existing callers sending `{ markdown }` only continue to work unchanged.
- All unit / smoke / a11y tests pass.

## Deferred follow-ups

- **F-9: Per-question "Try again"** — revisit if authors ask.
- **F-10: Live AI grader in preview** — needs a preview-only auth path + quota policy + spec-builder exposed outside HANA.
- **F-11: Branching-paths simulation** — wait for #172 to ship and consolidate the integration story.
- **F-12: Sibling files beyond rules.vr** — bump to `{ markdown, rulesVr?, extras?: {…} }` when a second sibling-file consumer appears.

## Related work / prior memories

- Original Preview API spec: [`2026-05-23-vscode-author-preview-design.md`](2026-05-23-vscode-author-preview-design.md)
- Validation widget modernization: [`2026-06-04-212-validation-widget-modernisation-design.md`](2026-06-04-212-validation-widget-modernisation-design.md)
- AI-authored quizzes: [`2026-06-05-208-ai-authored-quizzes-design.md`](2026-06-05-208-ai-authored-quizzes-design.md)
- Free-text grader: [`2026-06-04-209-free-text-grader-design.md`](2026-06-04-209-free-text-grader-design.md)
- AI code-check spike: [`2026-06-02-ai-code-check-spike-design.md`](2026-06-02-ai-code-check-spike-design.md)
- Branching paths: [`2026-06-09-172-branching-paths-design.md`](2026-06-09-172-branching-paths-design.md)
