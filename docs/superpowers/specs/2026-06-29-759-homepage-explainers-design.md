# Issue #759 — Explainer popovers for homepage and verb sub-pages

- **Status:** Approved (2026-06-29, spec-reviewer pass complete)
- **Issue:** [#759](https://github.com/sap-tutorials/tutorials-ims/issues/759)
- **Related spec:** [`2026-06-27-639-developer-homepage-design.md`](./2026-06-27-639-developer-homepage-design.md) (the spec that introduced the homepage redesign these popovers extend)
- **Related architecture doc:** [`docs/developers/architecture/homepage.md`](../../developers/architecture/homepage.md)

## Summary

The redesigned developer-portal homepage (issue #639) and its six verb sub-pages (`/learn/`, `/build/`, `/integrate/`, `/operate/`, `/ai/`, `/connect/`) currently render link tiles and link lists with little or no inline guidance. The verb-spine tiles show only the verb label plus the top three "Start here" titles; the directory footer shows ~60 bare-title links across six columns; verb sub-pages render the existing `HomepageShelves.description` field inline under each link but provide no per-shelf-category context.

A newcomer arriving on `/` cannot answer "what is each verb and why should I care?" without clicking. A developer scanning the directory footer or a verb sub-page cannot tell "SAP Joule" from "AI Foundation" or "Document Information Extraction" without leaving the page.

This spec adds a deeper layer of guidance — "who it's for / why it matters" content — on every link and tile across these surfaces, surfaced via two trigger patterns chosen to fit each surface: **flip cards on large tiles** (verb spine, verb sub-page shelf headers) and **hover popovers with a touch-accessible ⓘ icon on dense link lists** (directory footer, verb sub-page link cards). All content is admin-editable in the Fiori admin shell, with AI-generation actions (per-row and bulk-fill-blanks) that reuse the existing AI Core orchestration from the AI-authored-quizzes feature ([#208]) and the free-text grader ([#234]).

[#208]: https://github.com/sap-tutorials/tutorials-ims/issues/208
[#234]: https://github.com/sap-tutorials/tutorials-ims/issues/234

## Scope

### In scope

- Three surfaces gain explainer affordances:
  - **Verb spine** (homepage row 2) — 6 tiles become flip cards
  - **Directory footer** (homepage row 7) — ~60 link entries gain hover popover + ⓘ
  - **Verb sub-pages** (`/learn/`, `/build/`, `/integrate/`, `/operate/`, `/ai/`, `/connect/`) — shelf-section headers become flip cards; link cards within shelves gain hover popover + ⓘ
- Two new CDS entities (`VerbDefinitions`, `ShelfDefinitions`) and three new fields on the existing `HomepageShelves` entity (`tagline`, `whyItMatters`, `authoringStatus`)
- Two new Vue islands (`verb-flip-tile`, `link-explainer-popover`) compiled together as one Vite entry under `hugo-apps/src/homepage-explainers/`
- Two new admin Fiori Elements apps (Verb Definitions, Shelf Definitions); existing Homepage admin app gains an Explainer facet on the `HomepageShelves` object page
- Three new `AdminService` actions for AI generation (per entity), each supporting two modes (`fill-blanks`, `regenerate-selected`)
- Build-feed endpoints `/build/verb-definitions` and `/build/shelf-definitions`; existing `/build/homepage-shelves` extended with the three new fields
- Hybrid AI test gated by `HYBRID_AI_TESTS=true` (matches `categories-classifier.test.js` pattern from [#208])
- Playwright E2E spec for keyboard interaction + popover focus contract
- New architecture doc `docs/developers/architecture/homepage-explainers.md`

### Out of scope

- Changing the existing homepage hero, events band, video band, tutorials teaser, community lane, or shellbar
- Renaming any of the four shelves (`Start here`, `Reference`, `Tools & samples`, `Keep current`) — only their content gains explainer text
- Adding new link entries to `HomepageShelves` — this issue is purely about explainer content on existing rows
- Popovers on the tutorial-navigator page, on tutorial single pages, or on mission/group/category pages — different surfaces, different issues
- Translating explainer content into non-English locales — site is English-only ([memory: developers.sap.com Locales])
- Deprecating the existing `HomepageShelves.description` field — kept for graceful fallback inside popovers and for inline rendering on verb sub-pages

## Approach

The brainstorming session ([conversation log, 2026-06-29]) settled on four decisions that this design embodies:

1. **Three surfaces get popovers, not just verb tiles.** The issue title ("homepage / subpages") and the user's clarification confirm verb spine + directory footer + verb sub-pages.
2. **Surface-appropriate trigger model (option D).** Flip cards on large tiles where they look intentional; hover popover + ⓘ on dense link lists where 60 flipping cards would be chaos.
3. **Content shape: tagline + optional longer paragraph (option c).** Required short tagline forces every popover to answer "who is this for"; optional longer "why it matters" lets authors go deeper on the entries that warrant it. The existing `description` field renders as a third paragraph for graceful fallback.
4. **`VerbDefinitions` is a CDS entity (option a).** Non-engineers can maintain content via the admin Fiori app; AI-generate actions (per-row + bulk-fill-blanks) seed and augment every kind of row (verbs, shelf headers, individual link entries).

The Developer Advocates page (`hugo/content/developer-advocates/` + `hugo-apps/src/advocates/`) is the existing precedent for both the flip-card interaction and for fetching admin-editable content into a Vue island via build-time-baked JSON. We reuse its patterns end-to-end.

## 1. Architecture

### 1.1 Data flow

```text
Admin Fiori UI
  → AdminService.VerbDefinitions / ShelfDefinitions / HomepageShelves (writes)
    → HANA persistence
      → 60s-debounced GitHub workflow_dispatch (rebuild-content.yml, catalog-only mode)
        → npm run build:all on CI
          → scripts/fetch-tutorials.ts orchestrates:
              GET /build/homepage-shelves   → hugo/data/homepage_shelves.json
              GET /build/verb-definitions   → hugo/data/verb_definitions.json
              GET /build/shelf-definitions  → hugo/data/shelf_definitions.json
            → Hugo render reads three JSON files
              → static HTML in approuter (excluding tutorials)

Browser
  → loads /js/homepage-explainers.js (Vite-built island) only when data-page-kind ∈ {homepage, verb-*}
    → <verb-flip-tile> hydrates each tile / shelf header (front face = today's render)
    → <link-explainer-popover> hydrates each directory-footer link and each verb-sub-page link card
```

Admin save to visitor freshness: ~1 minute (60 s debounce + CI rebuild + approuter restart).

### 1.2 Component split

| Component | Surface | Trigger | Hosts content for |
|---|---|---|---|
| `<verb-flip-tile>` | Verb spine (homepage row 2) | Flip card | Per-verb tagline + whyItMatters (one of 6) |
| `<verb-flip-tile>` | Verb sub-page shelf headers | Flip card | Per-shelf tagline + whyItMatters (one of 4; shared across all 6 verbs) |
| `<link-explainer-popover>` | Directory footer (homepage row 7) | Hover + ⓘ | Per-shelf-entry tagline + whyItMatters + description (one per `HomepageShelves` row) |
| `<link-explainer-popover>` | Verb sub-page link cards | Hover + ⓘ | Per-shelf-entry tagline + whyItMatters + description (same rows the footer uses) |

Two components, four invocation sites. Both compiled into one Vite entry — `hugo/static/js/homepage-explainers.js`.

### 1.3 Trigger contracts

**`<verb-flip-tile>`** — front face = current rendering (icon + label + START_HERE preview list for verbs; bare `<h2>` for shelf headers). Back face = tagline (heading) + whyItMatters (paragraph) + small ↻ icon.

| Input | Behaviour |
|---|---|
| Pointer hover ≥ 250 ms | Flip to back |
| Pointer leaves (≥ 250 ms) | Flip to front |
| Click on front face | Navigate to `href` (verbs only; shelf headers have no `href`) |
| Click on back face | Navigate to `href` (verbs only); on shelf headers, no-op |
| Tab focus | Same as hover (flip to back); Shift+Tab away → flip to front |
| Space | Toggle flip state |
| Enter | Navigate (verbs); no-op (shelf headers) |
| Esc | Flip to front (if currently back) |
| Touch tap | First tap = flip; second tap on same tile = navigate (verbs) or stay (shelf headers); tap outside = flip to front |
| `prefers-reduced-motion: reduce` | Instant content-swap (no `rotateY` animation); hover-intent delay reduced to 0 |

**`<link-explainer-popover>`** — link itself renders unchanged. `ⓘ` icon to the right of the link (or beneath on narrow screens) is keyboard-focusable, `aria-label="More about <title>"`.

| Input | Behaviour |
|---|---|
| Pointer hover on link OR ⓘ ≥ 250 ms | Popover opens; `role="tooltip"` |
| Pointer leaves both | Popover closes |
| Click on ⓘ | Popover opens and stays; `role="dialog"` with focus trap |
| Click on link | Navigate; popover ignored |
| Tab to ⓘ | Popover opens; Shift+Tab returns focus to link |
| Esc (while popover open via click) | Close popover; focus returns to ⓘ |
| Click outside | Close popover |
| Touch tap on ⓘ | Open popover; tap × or outside = close |
| `prefers-reduced-motion: reduce` | Hover-intent delay = 0; opacity transition disabled |

**Empty-content fallback.** If `tagline`, `whyItMatters`, and `description` are all empty for a `HomepageShelves` row, the ⓘ icon is not rendered and the link stays bare. No empty popover. For `VerbDefinitions` and `ShelfDefinitions` rows with no content, the back face still renders with the front-face content (label only) — the flip becomes a near-no-op but never breaks. This is the graceful-degradation path during phased rollout, when rows are still `BLANK` between schema deploy and content seeding.

### 1.4 Popover body order

When at least one of the three fields is populated, the popover renders them in this order, each as a separate block, skipping empty values:

1. `tagline` — short bold heading-style text (≤ 140 chars)
2. `whyItMatters` — body paragraph (≤ 800 chars)
3. `description` — smaller, dimmer paragraph (≤ 280 chars, the existing field)

If only `description` exists (row not yet AI-seeded), the popover renders just that line — semantically equivalent to today's inline description on verb sub-pages, but reached via hover instead of inline. The ⓘ icon still renders so visitors have a discoverable affordance.

### 1.5 Page-kind script gating

`hugo/layouts/_default/baseof.html` already writes `data-page-kind` on `<html>` for routing of Joule starters and similar per-page bundles. The new `homepage-explainers.js` is loaded only when `data-page-kind` matches `homepage` or `verb-*`:

```html
{{ if or (eq .Params.pageKind "homepage") (hasPrefix .Params.pageKind "verb-") }}
  <script defer src="/js/homepage-explainers.js"></script>
{{ end }}
```

Tutorial pages, navigator, mission/group pages, etc., do not load the bundle.

## 2. Data model

### 2.1 New types

```cds
// In db/homepage.cds (existing file)

type AuthoringStatus : String enum {
  BLANK;      // never seeded; bulk-fill targets these
  AI_SEEDED;  // last write was the AI generator; not protected from bulk-fill
  REVIEWED;   // human has confirmed; bulk-fill skips; per-row regenerate requires confirm
}
```

### 2.2 New entity: `VerbDefinitions`

```cds
@assert.unique.verbKey: [verbKey]
entity VerbDefinitions : cuid, managed {
  verbKey          : HomepageVerb @mandatory @assert.range;
  label            : String(40)   @mandatory;
  iconName         : String(40);
  sortOrder        : Integer default 100;
  tagline          : String(140);
  whyItMatters     : String(800);
  authoringStatus  : AuthoringStatus default 'BLANK' @assert.range;
}
```

Cardinality: exactly 6 rows (one per `HomepageVerb` enum value). Seeded via `db/data/com.sap.developers.ims-VerbDefinitions.csv` with stable UUIDs. Admins edit content fields; `verbKey` is read-only on the object page; new rows cannot be created and existing rows cannot be deleted via the admin UI (Fiori Elements `@Common.IsActionCritical` + manifest-level guard).

### 2.3 New entity: `ShelfDefinitions`

```cds
@assert.unique.shelfKey: [shelfKey]
entity ShelfDefinitions : cuid, managed {
  shelfKey         : HomepageShelf @mandatory @assert.range;
  label            : String(40)    @mandatory;
  sortOrder        : Integer default 100;
  tagline          : String(140);
  whyItMatters     : String(800);
  authoringStatus  : AuthoringStatus default 'BLANK' @assert.range;
}
```

Cardinality: exactly 4 rows (one per `HomepageShelf` enum value). Same CRUD constraints as `VerbDefinitions`. Content is shared across all six verb sub-pages — `REFERENCE` means the same thing on `/learn/` and `/operate/`.

### 2.4 New fields on `HomepageShelves`

```cds
entity HomepageShelves : cuid, managed {
  // ... existing fields unchanged ...
  tagline          : String(140);
  whyItMatters     : String(800);
  authoringStatus  : AuthoringStatus default 'BLANK' @assert.range;
}
```

All three new fields are nullable and have no FK references. Migration is pure additive HDI deploy. The existing `description : String(280)` field is **kept** and continues to render inline on verb sub-pages and as a third paragraph inside popovers.

### 2.5 Seed CSVs

`db/data/com.sap.developers.ims-VerbDefinitions.csv` ships with all 6 rows, `label` and `iconName` populated to match today's hard-coded values in `verb-spine.html`:

| verbKey | label | iconName |
|---|---|---|
| LEARN | Learn | learning-assistant |
| BUILD | Build | developer-settings |
| INTEGRATE | Integrate | chain-link |
| OPERATE | Operate | settings |
| AI | Extend with AI | da |
| CONNECT | Connect | customer-and-contacts |

`tagline`, `whyItMatters`, `authoringStatus` left blank/default (`BLANK`) so the first AI bulk-fill seeds them.

`db/data/com.sap.developers.ims-ShelfDefinitions.csv` ships with all 4 rows, `label` populated to match today's hard-coded dict in `verb/list.html`:

| shelfKey | label |
|---|---|
| START_HERE | Start here |
| REFERENCE | Reference |
| TOOLS | Tools & samples |
| KEEP_CURRENT | Keep current |

### 2.6 Migration discipline

Per [memory: cds build --production for db/last-dev/]: schema change requires `cds build --production` + staging `db/last-dev/` + `db/src/`. The PR splitting the schema change touches `db/homepage.cds`, the two new seed CSVs, and the generated HDI artifacts under `db/last-dev/` and `db/src/`. The check-cds-build-staging guard ([memory: check-cds-build-staging fires on ANY srv/ change]) verifies the staging is current.

## 3. Services

### 3.1 Service surface

Three CDS entities exposed on `AdminService` (existing) with admin scope:

```cds
extend service AdminService {
  @odata.draft.enabled
  entity VerbDefinitions as projection on ims.VerbDefinitions;

  @odata.draft.enabled
  entity ShelfDefinitions as projection on ims.ShelfDefinitions;

  // HomepageShelves projection already exists; just inherits new fields
}
```

Per [memory: Fiori CAP editing defaults to draft] — draft enabled for editor experience.

### 3.2 Build-feed endpoints

`/build/verb-definitions` and `/build/shelf-definitions` mirror the existing `/build/homepage-shelves` shape — unauthenticated GET, returns sorted JSON, response is the input to `hugo/data/<file>.json`. Implementation in `srv/developer-service.js` as two new express routes registered in `cds.on('bootstrap')`.

```http
GET /build/verb-definitions
→ 200 { verbs: [ { verbKey, label, iconName, sortOrder, tagline, whyItMatters, authoringStatus }, ... ] }

GET /build/shelf-definitions
→ 200 { shelves: [ { shelfKey, label, sortOrder, tagline, whyItMatters, authoringStatus }, ... ] }
```

`authoringStatus` is included in the build payload so Hugo templates can render an "explainer pending review" indicator (e.g., dotted underline on the ⓘ icon) — disabled by default; useful for staging/QA channels.

The existing `/build/homepage-shelves` payload gains the three new fields (`tagline`, `whyItMatters`, `authoringStatus`) on each shelf entry. Backwards-compatible: any consumer that ignores unknown keys continues to work.

### 3.3 AI generation actions

```cds
extend service AdminService {
  action generateVerbExplainers(
    ids   : array of String,
    mode  : String  // 'fill-blanks' | 'regenerate-selected'
  ) returns { processed: Integer; skipped: Integer; cost: String };

  action generateShelfExplainers(
    ids   : array of String,
    mode  : String
  ) returns { processed: Integer; skipped: Integer; cost: String };

  action generateShelfEntryExplainers(
    ids   : array of String,
    mode  : String
  ) returns { processed: Integer; skipped: Integer; cost: String };
}
```

**Mode `fill-blanks`** — `ids` ignored; backend selects all rows where `authoringStatus = 'BLANK'`. Bulk button on each list-report toolbar.

**Mode `regenerate-selected`** — operates on the supplied `ids`. Row action + multi-select toolbar action. If any selected row has `authoringStatus = 'REVIEWED'`, the UI surfaces a confirm dialog before invoking.

**Hard cap:** 100 entries per call (matches `AI_AUTHOR_BUILD_CAP` from #208). Calls with > 100 ids return `{ error: 'CAP_EXCEEDED', limit: 100 }` (HTTP 400).

**Return shape:** `processed` = rows successfully written; `skipped` = rows AI returned malformed/empty output for (logged but not failed); `cost` = USD-cent string (rounded up), surfaced in success toast.

**Status transitions:**

| Mode | Before | After |
|---|---|---|
| `fill-blanks` | `BLANK` | `AI_SEEDED` |
| `fill-blanks` | `AI_SEEDED` | (skipped — not in selection) |
| `fill-blanks` | `REVIEWED` | (skipped — not in selection) |
| `regenerate-selected` | any | `AI_SEEDED` |

**Auth:** all three actions require the admin scope (existing `@requires: 'admin'` on `AdminService`).

**Kill switch:** env var `AICORE_EXPLAINER_GENERATOR_DISABLED=true` on the srv app makes all three actions return `{ error: 'AI_GENERATION_DISABLED' }` (HTTP 503). Matches the kill-switch pattern from #208.

### 3.4 AI orchestrator: `srv/lib/explainer-generator.js`

```js
// Pseudocode — actual contract
async function generateExplainer({ kind, row, context }) {
  // kind: 'verb' | 'shelf' | 'shelf-entry'
  // row:  the entity row already loaded by the action handler
  // context: { verbDefinition?: VerbDefinitionsRow } — for shelf-entry, the entry's verb's definition
  //
  // Builds prompt using:
  //   - kind-specific system prompt (3 prompts)
  //   - row identity fields (title, url, label)
  //   - existing row.description (where applicable)
  //   - context.verbDefinition.tagline (for shelf-entry — the lane this entry lives in)
  //
  // Calls AI Core via srv/lib/aicore-service-key.js + the AI Core SDK
  //   (already in package.json — same path used by AI-authored quizzes / free-text grader).
  // Constrained to a JSON Schema:
  //   { tagline: { type: 'string', maxLength: 140 },
  //     whyItMatters: { type: 'string', maxLength: 800 } }
  // SDK retries on schema-validation failure; throws after 3 attempts.
  //
  // Returns: { tagline, whyItMatters, costCents }
  //   or null on terminal failure (caller increments skipped).
}
```

**Module reuse.** `srv/lib/aicore-service-key.js` already exists (used by #208 AI-authored quizzes and #234 free-text grader); no new module needed. The AI Core SDK is already in `package.json`.

**System prompts** live in `srv/lib/prompts/explainer-{verb,shelf,shelf-entry}.md` and are version-controlled. Each prompt is ≤ 1000 tokens and includes:

- audience cue (newcomer to SAP; assume technical literacy)
- length guidance (tagline ≤ 140 chars; whyItMatters one-to-three short paragraphs)
- the row identity fields as variables
- shelf-entry prompts also include the lane (`verbDefinition.tagline`) as context

**Cost accounting:** the AI Core SDK reports token usage per call; the orchestrator multiplies by current per-1k-token rates (constants in `srv/lib/explainer-generator.js`) and rounds up to the next cent. Cost is summed across the batch and returned to the action handler.

## 4. UI

### 4.1 Vue island bundle

```text
hugo-apps/src/homepage-explainers/
  main.ts                      # registers both web components
  verb-flip-tile.vue           # the flip card
  link-explainer-popover.vue   # the hover popover
  shared/
    flip-card.css              # 3D transform + reduced-motion media query
    popover.css                # SAP Fundamental tile shadow, theme tokens
    use-hover-intent.ts        # 250 ms delay helper (shared)
    use-popover-position.ts    # viewport-edge detection (no FloatingUI dep)
```

One Vite entry in `hugo-apps/vite.config.ts` → emits `hugo/static/js/homepage-explainers.js`. Both components register as web components (custom elements) — Hugo templates use the element name directly:

```html
<verb-flip-tile
  verb-key="LEARN"
  label="Learn"
  icon-name="learning-assistant"
  tagline="..."
  why-it-matters="..."
  href="/learn/">
  <!-- slot: preview list (3 START_HERE titles) renders unchanged when collapsed -->
  <ul class="hp-verb__preview">...</ul>
</verb-flip-tile>

<link-explainer-popover
  entry-id="66333900-..."
  title="SAP Joule"
  tagline="..."
  why-it-matters="..."
  description="..."
  href="https://help.sap.com/docs/joule"
  badge="NEW">
  <!-- slot: the link itself, rendered by Hugo with existing semantics -->
  <a href="https://help.sap.com/docs/joule" target="_blank" rel="noopener">SAP Joule</a>
</link-explainer-popover>
```

The slot pattern means Hugo continues to own the SEO-relevant markup (the `<a>` element) — the Vue island only adds interactive behaviour around it. Critical for SSR-equivalent first-paint: an empty bundle still leaves a working set of links.

### 4.2 Hugo template changes

| File | Change |
|---|---|
| `hugo/layouts/partials/homepage/verb-spine.html` | (a) Drop hard-coded `$verbDefs` slice; read from `Site.Data.verb_definitions.verbs`. (b) Wrap each `<a class="hp-verb">` with `<verb-flip-tile>`, passing label/icon/tagline/whyItMatters/href. Preview list stays inside the slot. |
| `hugo/layouts/partials/homepage/directory-footer.html` | Wrap each `<li><a>` with `<link-explainer-popover>`, passing entry fields. |
| `hugo/layouts/verb/list.html` | (a) Read shelf labels and explainer content from `Site.Data.shelf_definitions.shelves` instead of the hard-coded dict. (b) Wrap each `<section class="verb-shelf">` header with `<verb-flip-tile>` (no `href`). (c) Wrap each `<li>` link card with `<link-explainer-popover>`. |
| `hugo/layouts/_default/baseof.html` | Add the `<script defer>` tag for `/js/homepage-explainers.js`, gated by `data-page-kind` match. |

### 4.3 CSS

New file `hugo-apps/src/homepage-explainers/shared/flip-card.css`:

- `.flip-card`: `perspective: 800px`, `transform-style: preserve-3d`
- `.flip-card[data-flipped="true"]`: `transform: rotateY(180deg)`
- `@media (prefers-reduced-motion: reduce) .flip-card { transition: none; }` + JS-side toggling of `display` instead of `transform`

New file `hugo-apps/src/homepage-explainers/shared/popover.css`:

- `.explainer-popover`: 320 px wide, max-height 280 px with internal scroll, SAP Fundamental `--sapShellColor` shadow tokens
- `.explainer-popover__tagline`: `--sapTitleColor`, font-weight 600
- `.explainer-popover__description`: `--sapNeutralTextColor`, smaller font

Theme tokens already provided by the existing `sap_horizon` / `sap_horizon_dark` bootstrap in `baseof.html`.

### 4.4 Admin UI

#### New apps

- `app/admin/verb-definitions/` — Fiori Elements list-report + object-page; standard `manifest.json` + `Component.js`; minimal annotations in `app/admin-annotations.cds`.
- `app/admin/shelf-definitions/` — same shape.

Both register as `componentUsages` in `app/admin-shell/webapp/manifest.json` and `Component.js`. New side-nav grouping "Explainers" contains: Verb Definitions, Shelf Definitions, Homepage Shelves (existing app moved under this group).

#### Existing app updates

- `app/admin/homepage/` (existing) gains an "Explainer" facet on the `HomepageShelves` object page showing tagline + whyItMatters + authoringStatus + AI action buttons.

#### List-report features (all three apps)

- Toolbar: "Generate for blank rows" button (calls `generate*Explainers(mode: 'fill-blanks')` with confirm dialog showing count + cost estimate)
- Row action: "Regenerate with AI" (calls `generate*Explainers(ids: [row.ID], mode: 'regenerate-selected')`)
- Multi-select toolbar action: "Regenerate selected" (same action with multiple ids)
- `authoringStatus` column with criticality colors (red BLANK / amber AI_SEEDED / green REVIEWED)
- Filter chip presets: "Blank rows", "AI-seeded — needs review", "Reviewed"

#### Object-page features

- Authoring facet shows current `authoringStatus`
- "Mark as reviewed" button transitions `AI_SEEDED → REVIEWED` (manual editorial sign-off)
- Inline edit of `tagline` and `whyItMatters` with character counters (140 / 800)

#### CRUD lockdown (Verb Definitions and Shelf Definitions only)

- New entry creation hidden in list report
- Delete action hidden in list and on object page
- `verbKey` / `shelfKey` rendered read-only on object page
- (`HomepageShelves` keeps full CRUD — link entries are mutable)

### 4.5 Cost estimation in confirm dialog

Before firing a `fill-blanks` action, the admin UI displays:
> "Generate AI explainers for **N** blank rows? Estimated cost: **$X.XX**. This will not overwrite AI-seeded or human-reviewed rows."

Where the estimate is computed client-side as `N × 1.5 cents` (a conservative per-call estimate; actual cost returned in the success toast). The constant `1.5` lives in the admin app's manifest config so we can tune it without a code change.

## 5. Build, deploy, and freshness

### 5.1 Build pipeline integration

`scripts/fetch-tutorials.ts` (or its build orchestrator counterpart) gains two new fetch steps in the catalog-data phase:

```text
GET ${CAP_BASE_URL}/build/verb-definitions   → hugo/data/verb_definitions.json
GET ${CAP_BASE_URL}/build/shelf-definitions  → hugo/data/shelf_definitions.json
```

Both fail loud: a 5xx response from either endpoint fails the build. No silently-empty file. Both endpoints are unauthenticated and idempotent — safe to call from CI and from local dev.

Per [memory: build:all needs CAP_BASE_URL]: fresh-shell builds require the env var. Documented in the existing CLAUDE.md commands section.

### 5.2 Rebuild classification

`srv/lib/_classify-rebuild-mode.js` gains three case branches:

- `VerbDefinitions` write → `mode: 'catalog-only'`
- `ShelfDefinitions` write → `mode: 'catalog-only'`
- `HomepageShelves` write on the new fields → unchanged (`catalog-only`; same as today's writes on this entity)

Visitor freshness after admin save: ~1 minute (60 s debounce → `rebuild-content.yml` catalog-only → approuter cycle).

### 5.3 mta.yaml changes

`srv-qa` cp-list audit per [memory: srv-qa cp-list Transitive Deps]: `srv/lib/explainer-generator.js` must be added to the srv-qa module's `cp` list in `.deploy/mta.yaml`. The prompt files under `srv/lib/prompts/explainer-*.md` are **data files, not JS modules** — the transitive-import walker that the cp-list audit normally uses will not find them via `import` statements. They must be added to the cp list **manually**. Audit step is part of the implementation plan and explicitly covers both the JS and the `.md` data files.

### 5.4 Rollback

Pure additive feature; rollback is `git revert` + redeploy:

| Layer | Rollback behaviour |
|---|---|
| Schema | New fields/entities are nullable / unreferenced; leave in place across revert |
| Hugo templates | Reverted templates render today's exact HTML (link/tile work) |
| Vue bundle | Bundle removal removes the affordance, not the links |
| Admin apps | Removing side-nav entries hides them; entity data untouched |
| AI orchestrator | Setting `AICORE_EXPLAINER_GENERATOR_DISABLED=true` immediately disables generation without redeploy |

No data migration to undo. No feature-flag needed for the visitor side because the empty-content fallback in §1.3 already covers the "schema deployed but content not yet seeded" state.

## 6. Testing

| Tier | New / extended test | Purpose |
|---|---|---|
| Unit | `test/unit/explainer-generator.test.js` | Schema validation, prompt assembly, cost calculation, kill-switch behaviour (mocks AI Core) |
| Unit | `test/unit/admin-explainer-actions.test.js` | Auth check, cost-cap enforcement, status transitions, REVIEWED-row protection |
| Unit | `test/unit/build-feeds-explainers.test.js` | `/build/verb-definitions` + `/build/shelf-definitions` shape; field inclusion in `/build/homepage-shelves` |
| Hybrid | `test/hybrid/verb-definitions-crud.test.js` | Admin CRUD against real HANA; `@assert.unique.verbKey`; create/delete locked at API layer |
| Hybrid | `test/hybrid/shelf-definitions-crud.test.js` | Same shape for `ShelfDefinitions` |
| Hybrid | `test/hybrid/homepage-shelves-new-fields.test.js` | New fields write/read correctly; status transitions |
| Hybrid (AI-gated) | `test/hybrid/explainer-generation.test.js` — gated by `HYBRID_AI_TESTS=true` | One real AI Core call per kind (verb / shelf / shelf-entry); asserts JSON-schema shape and status transition |
| Smoke | extends `test/smoke/build-feeds.test.js` | `/build/verb-definitions` and `/build/shelf-definitions` return 200 with expected shape post-deploy |
| Playwright E2E | `test/e2e/homepage-explainers.spec.ts` | Verb tile flips on Space; popover opens on hover; ESC closes; focus trap works; reduced-motion swaps without animation |

The Playwright E2E runs in CI as part of `npm run test:smoke` (deployed-app, headless Chromium). The hybrid AI test stays $0 / run by default ([memory: `HYBRID_AI_TESTS=true` to opt into category-classifier hybrid test]).

## 7. Telemetry

Two lightweight events fired client-side, posted to the existing `/api/event-stream` channel:

```js
{ event: 'homepage-explainer.flip',
  surface: 'verb-spine' | 'shelf-header',
  key: 'LEARN' | 'START_HERE' | ... }

{ event: 'homepage-explainer.popover',
  surface: 'directory-footer' | 'verb-shelf-item',
  entryId: '<HomepageShelves.ID>' }
```

Both throttled client-side at 500 ms debounce. Aggregated in the existing analytics pipeline. Used at 30-day post-launch review to answer "are people using the explainers, and which surfaces drive the most engagement?"

No PII. No user identifier — these are anonymous interaction counters.

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| `/build/verb-definitions` 5xx during `build:all` | Build fails loudly |
| `/build/shelf-definitions` 5xx during `build:all` | Build fails loudly |
| Verb-spine renders before `homepage-explainers.js` loads | First paint = today's static front face; JS hydrates → flip becomes available; no flash, no broken state |
| `tagline` + `whyItMatters` + `description` all empty for a `HomepageShelves` row | ⓘ icon not rendered; link stays bare |
| `VerbDefinitions` or `ShelfDefinitions` row content all empty | Front face renders; flip becomes near-no-op back face with just the label |
| Popover collides with viewport edge | `use-popover-position.ts` auto-flips above / shifts inward |
| AI generate action called with no AI Core binding | Returns HTTP 503 `{ error: 'AI_CORE_UNAVAILABLE' }`; admin sees toast; manual editing still works |
| AI generate action exceeds 100-row cap | Returns HTTP 400 `{ error: 'CAP_EXCEEDED', limit: 100 }`; admin UI prompts to split |
| AI Core returns malformed JSON 3× | Row is skipped (logged); `skipped` counter incremented; action otherwise succeeds |
| `prefers-reduced-motion: reduce` | Flip = instant content swap; hover-intent delay = 0 |
| Touch device (no hover capability) | ⓘ icon is the affordance — tap to open popover; first tap on tile flips, second tap navigates |
| `AICORE_EXPLAINER_GENERATOR_DISABLED=true` | All three AI actions return 503; admin UI surfaces banner |
| `HomepageShelves` deleted while admin has popover open | No effect — popovers are static after build-time bake |

## 9. Rollout plan

The work splits into five PRs, each independently shippable:

### PR 1 — Schema and build feeds (foundation)

- Add `AuthoringStatus` type, `VerbDefinitions` and `ShelfDefinitions` entities, three new fields on `HomepageShelves` in `db/homepage.cds`
- Add seed CSVs with labels filled, content blank
- Add `/build/verb-definitions` and `/build/shelf-definitions` routes; extend `/build/homepage-shelves` payload
- Wire the two new endpoints into `scripts/fetch-tutorials.ts` → baked JSON
- Hugo templates still hard-coded — no visitor-observable change
- Tests: unit (build-feeds), hybrid (CRUD for both new entities, new-fields on shelves), smoke (build-feeds)

### PR 2 — Vue islands and Hugo wiring

- Add `hugo-apps/src/homepage-explainers/` with `verb-flip-tile` + `link-explainer-popover`
- Wire into `verb-spine.html`, `directory-footer.html`, `verb/list.html`
- Drop hard-coded `$verbDefs` slice and shelf-label dict; read from baked JSON
- Add Playwright E2E spec
- Visitor-observable change: ⓘ icons appear and tile flips work, but content is empty fallback (graceful — only labels visible on back face)
- Tests: Playwright E2E, vitest island unit tests

### PR 3 — Admin UI and AI generation

- Add `app/admin/verb-definitions/` and `app/admin/shelf-definitions/` Fiori apps
- Add new "Explainers" side-nav grouping to admin shell
- Extend `app/admin/homepage/` with the Explainer facet
- Add `srv/lib/explainer-generator.js` + three AdminService actions + three system prompts
- Add `AICORE_EXPLAINER_GENERATOR_DISABLED` kill switch
- srv-qa cp-list audit
- Visitor-observable change: none (rows still BLANK)
- Tests: unit (orchestrator, actions), hybrid AI test (gated)

### PR 4 — Content seed and editorial pass

- Run bulk-fill-blanks against DEV for all three entities. Each entity is its own action call (verbs / shelves / shelf-entries) and each is well under the 100-row hard cap from §3.3: 6 verbs + 4 shelves + 60 entries = 70 total, in three batches of 6 / 4 / 60. No batching logic needed beyond the per-entity action boundary. Estimated cost ~$1.
- Editorial review of the 6 verb explainers (most-seen surface); transition `AI_SEEDED → REVIEWED` for verbs
- Optional editorial review of the 4 shelf explainers
- Spot-check ~10 directory-footer entries; leave the rest as `AI_SEEDED`
- Visitor-observable change: verb tiles get flip back faces; shelf headers flip; directory footer + verb sub-page link cards gain working popovers
- Tests: visual regression spot check via Playwright trace

### PR 5 — PROD cutover (post PROD spinup, ≥ July 2026)

Per [memory: PROD cutover July 2026]:

- Schema deploy to PROD
- Export `VerbDefinitions` / `ShelfDefinitions` from DEV via `scripts/migrate-reference-data.js` (extend the script to cover the two new entity types — `HomepageShelves` is already covered)
- Import to PROD
- Trigger one `rebuild-content.yml` run

## 10. Documentation

New page `docs/developers/architecture/homepage-explainers.md` covering:

- Data model summary
- The two Vue components and where they attach
- The three Admin Service actions and their modes
- AI generation flow and prompt locations
- Kill switch env var
- Authoring-status workflow

Updated:

- `docs/developers/architecture/homepage.md` — add a "Explainer popovers" section linking to the new doc
- `docs/developers/operations/testing-endpoints.md` — add `/build/verb-definitions` and `/build/shelf-definitions` rows
- `CLAUDE.md` — add `AICORE_EXPLAINER_GENERATOR_DISABLED` to the env-vars gotchas list

Sidebar registration in `docs/.vitepress/config.ts` per [memory: VitePress base path] — the predocs:build guard rejects unregistered pages.

## 11. Open questions

None at spec-write time. Decisions reached in brainstorming:

1. **Scope** — all three surfaces (verb spine + directory footer + verb sub-pages) with deeper info on individual links.
2. **Trigger model** — surface-appropriate hybrid (flip cards on big tiles + hover popover + ⓘ on dense link lists).
3. **Content shape** — short structured tagline + optional longer `whyItMatters` + graceful fallback to existing `description`.
4. **Verb content location** — CDS entity (`VerbDefinitions`) for admin self-service.
5. **AI scope** — all three kinds AI-fillable (verbs, shelf headers, individual link entries) with per-row regenerate + bulk-fill-blanks modes.
6. **Admin-side-nav grouping** — new "Explainers" group containing Verb Definitions / Shelf Definitions / Homepage Shelves.
7. **Cost surfacing** — show in success toast as a deliberate "this spends money" signal.
8. **`whyItMatters` length cap** — `String(800)` for popover readability.

## 12. References

- Brainstorming session: 2026-06-29 (in-conversation)
- Homepage redesign spec: [`2026-06-27-639-developer-homepage-design.md`](./2026-06-27-639-developer-homepage-design.md)
- Homepage architecture: [`docs/developers/architecture/homepage.md`](../../developers/architecture/homepage.md)
- AI-authored quizzes spec: [`2026-06-05-208-ai-authored-quizzes-design.md`](./2026-06-05-208-ai-authored-quizzes-design.md) — pattern source for AI orchestration, cost cap, kill switch, hybrid-AI test gating
- Categories reclassify pattern: [memory: Categories reclassify is destructive] — source for the destructive-confirm dialog UX
- Developer Advocates page: `hugo/content/developer-advocates/` + `hugo-apps/src/advocates/` — flip-card precedent
