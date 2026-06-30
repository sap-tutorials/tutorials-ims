---
title: Homepage Explainer Popovers
description: Per-verb, per-shelf, and per-link explainer content for the developer homepage — data model, services, AI generation, and authoring workflow.
---

# Homepage Explainer Popovers

The homepage verb spine, directory footer, and verb sub-pages all gain progressive-disclosure explainer affordances:

- **Verb cards** (6 tiles on the homepage) flip to a back face on click, revealing a tagline + "why it matters" paragraph for that verb.
- **Shelf headers** on verb sub-pages flip to reveal the shelf category's role.
- **Individual link cards** in the directory footer and verb sub-pages gain an `ⓘ` icon that opens a popover with the link's tagline + `whyItMatters`.

All three surfaces gracefully degrade to the existing label or description when content is blank.

**Spec:** [docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md](../../superpowers/specs/2026-06-29-759-homepage-explainers-design.md)

**Related:** [Homepage architecture](homepage.md) — the broader homepage data flow this layers on top of.

---

## Components

| Layer | Component | Source |
|-------|-----------|--------|
| **Data model** | `VerbDefinitions` (6 rows) + `ShelfDefinitions` (4 rows) entities | [db/homepage.cds](../../../db/homepage.cds) |
| **Data model** | `HomepageShelves.tagline` / `.whyItMatters` / `.authoringStatus` (3 new fields) | [db/homepage.cds](../../../db/homepage.cds) |
| **Data model** | `AuthoringStatus` enum (`BLANK` \| `AI_SEEDED` \| `REVIEWED`) | [db/homepage.cds](../../../db/homepage.cds) |
| **Build feed** | `GET /build/verb-definitions` | [srv/server.js](../../../srv/server.js) |
| **Build feed** | `GET /build/shelf-definitions` | [srv/server.js](../../../srv/server.js) |
| **Build feed** | `GET /build/homepage-shelves` (existing — now includes the 3 new fields) | [srv/server.js](../../../srv/server.js) |
| **Fetcher** | `scripts/fetch-verb-definitions.ts` → `hugo/data/verb_definitions.json` | Build pipeline |
| **Fetcher** | `scripts/fetch-shelf-definitions.ts` → `hugo/data/shelf_definitions.json` | Build pipeline |
| **Admin actions** | `AdminService.generateVerbExplainers`, `generateShelfExplainers`, `generateShelfEntryExplainers` | [srv/admin-service.cds](../../../srv/admin-service.cds), [srv/admin-service.js](../../../srv/admin-service.js) |
| **Bulk Mark-reviewed** | `AdminService.bulkMarkVerbExplainerReviewed`, `bulkMarkShelfExplainerReviewed`, `bulkMarkShelfEntryExplainerReviewed` (#790) | [srv/admin-service.cds](../../../srv/admin-service.cds), [srv/admin-service.js](../../../srv/admin-service.js) |
| **AI orchestrator** | `srv/lib/explainer-generator.js` (SAP AI Core + structured prompts) | [srv/lib/explainer-generator.js](../../../srv/lib/explainer-generator.js) |
| **System prompts** | `srv/lib/prompts/explainer-{verb,shelf,shelf-entry}.txt` | [srv/lib/prompts/](../../../srv/lib/prompts/) |
| **Vue islands** | `verb-flip-tile`, `link-explainer-popover` | [hugo-apps/src/homepage-explainers/](../../../hugo-apps/src/homepage-explainers/) |
| **Hugo wiring** | `verb-spine.html`, `directory-footer.html`, `verb/list.html` | [hugo/layouts/partials/homepage/](../../../hugo/layouts/partials/homepage/) |
| **Admin Fiori apps** | `verb-definitions/`, `shelf-definitions/` | [app/admin/](../../../app/admin/) |
| **Admin Fiori facet** | `homepage/` app — Explainer facet on the Object Page | [app/admin/homepage/](../../../app/admin/homepage/) |
| **Kill switch** | `AICORE_EXPLAINER_GENERATOR_DISABLED` env var | (see `CLAUDE.md` > "Gotchas") |

---

## Data model

### Entities

**`VerbDefinitions`** — one row per `HomepageVerb` enum value (6 total: `LEARN` / `BUILD` / `INTEGRATE` / `OPERATE` / `AI` / `CONNECT`). Seed CSV at [db/data/com.sap.developers.ims-VerbDefinitions.csv](../../../db/data/com.sap.developers.ims-VerbDefinitions.csv).

| Field | Type | Notes |
|---|---|---|
| `verbKey` | `HomepageVerb` enum, unique | Identifies which homepage verb this row backs |
| `label` | `String(40)` | Display label (e.g. "Learn") — admin-editable |
| `iconName` | `String(40)` | SAP icon font name (e.g. `learning-assistant`) |
| `sortOrder` | `Integer` | Verb-spine column order |
| `tagline` | `String(140)` | Single-line subtitle on the flip-back face |
| `whyItMatters` | `String(800)` | Paragraph body on the flip-back face |
| `authoringStatus` | `AuthoringStatus` | `BLANK` \| `AI_SEEDED` \| `REVIEWED` |

**`ShelfDefinitions`** — one row per `HomepageShelf` enum value (4 total: `LEARN` / `START` / `REFERENCE` / `COMMUNITY`). Content is shared across all 6 verb sub-pages — `REFERENCE` means the same thing on `/learn/` and `/operate/`. Seed CSV at [db/data/com.sap.developers.ims-ShelfDefinitions.csv](../../../db/data/com.sap.developers.ims-ShelfDefinitions.csv).

| Field | Type | Notes |
|---|---|---|
| `shelfKey` | `HomepageShelf` enum, unique | Identifies which shelf category this row backs |
| `label` | `String(40)` | Display label |
| `sortOrder` | `Integer` | Display order within a verb sub-page |
| `tagline` | `String(140)` | Single-line subtitle |
| `whyItMatters` | `String(800)` | Paragraph body |
| `authoringStatus` | `AuthoringStatus` | `BLANK` \| `AI_SEEDED` \| `REVIEWED` |

**`HomepageShelves`** (existing entity, extended) — per-link explainer content. Each of the ~60 shelf entries gets its own tagline and whyItMatters that surface in the directory-footer popover and the verb sub-page link cards.

### `AuthoringStatus` lifecycle

```
BLANK ──(generate*Explainers)──> AI_SEEDED ──(human edit + save)──> REVIEWED
```

- **`BLANK`** — never seeded; tagline + whyItMatters are NULL. UI falls back to the existing `description` (for shelf entries) or to label-only (for verbs / shelves).
- **`AI_SEEDED`** — last write came from the AI generator. Bulk-fill modes skip `BLANK` rows in a no-op (already seeded), but per-row regenerate still works.
- **`REVIEWED`** — a human has confirmed the content. Bulk-fill skips `REVIEWED` rows. Per-row regenerate works but surfaces a destructive-confirm dialog (matching the same "destructive operation requires confirm" pattern used by the Categories reclassify action).

---

## Build feeds

Three build-time endpoints, all anonymous and 60-second cached. Consumed by Hugo build scripts at every full / catalog-only rebuild.

| Endpoint | Returns | Baked to |
|---|---|---|
| `GET /build/verb-definitions` | `{ verbs: [...], buildAt }` | `hugo/data/verb_definitions.json` |
| `GET /build/shelf-definitions` | `{ shelves: [...], buildAt }` | `hugo/data/shelf_definitions.json` |
| `GET /build/homepage-shelves` | `{ shelves: [...], buildAt }` (now includes `tagline` / `whyItMatters` / `authoringStatus`) | `hugo/data/homepage_shelves.json` |

Both new endpoints read directly from the raw entity (not through `AdminService`) so they stay unauthenticated. The fetcher scripts treat an empty-array response as warn-and-continue, matching the existing `/build/homepage-shelves` precedent — a freshly deployed subaccount with no admin reads yet won't crash the Hugo build.

### Rebuild classification

Writes to any of the three entities classify as `catalog-only` rebuild mode ([srv/lib/_classify-rebuild-mode.js](../../../srv/lib/_classify-rebuild-mode.js)) — the admin save debounce-dispatches `rebuild-content.yml` in ~1 minute, which re-fetches the JSON feeds and rebuilds Hugo. No tutorial-HTML republish is needed.

---

## AI generation

Three `AdminService` actions, all admin-gated, all routed through the same orchestrator:

```cds
action generateVerbExplainers       (ids : array of String, mode : String) returns ExplainerActionResult;
action generateShelfExplainers      (ids : array of String, mode : String) returns ExplainerActionResult;
action generateShelfEntryExplainers (ids : array of String, mode : String) returns ExplainerActionResult;
```

### Modes

| `mode` | Behavior |
|---|---|
| `'all'` | Generate for every row of this entity, regardless of `authoringStatus`. Per-row regenerate uses this. |
| `'blanks'` | Skip rows where `authoringStatus = 'REVIEWED'`. Bulk-fill mode. Default in the admin UI. |
| `'selected'` | Use the `ids` array. The admin UI's per-row "Regenerate" button uses this with one ID. |

### Hard limits

- **100 rows per call**, enforced server-side. The current row counts (6 verbs + 4 shelves + ~60 shelf entries) all fit in one call per entity.
- **Cost cap** — `~$0.01` per row at GPT-4.1-mini list prices; ~$0.70 to AI-seed the whole catalog. Each call's measured cost is surfaced to the operator in the success toast.

### Kill switch

When `AICORE_EXPLAINER_GENERATOR_DISABLED=true` is set on the `tutorials-srv` app, all three actions return `503` immediately. Use for incident response — quota burned, prompt regression, cost runaway. **Hand-authored content survives** — only AI generation is blocked. Set via:

```bash
cf set-env tutorials-srv AICORE_EXPLAINER_GENERATOR_DISABLED true
cf restart tutorials-srv
```

To re-enable, unset (`cf unset-env tutorials-srv AICORE_EXPLAINER_GENERATOR_DISABLED`) and restart.

### Orchestrator

[srv/lib/explainer-generator.js](../../../srv/lib/explainer-generator.js) exposes `generateExplainer({ kind, row, context })` — a single function the three action handlers call. It:

1. Loads the right system prompt from `srv/lib/prompts/explainer-{kind}.txt`.
2. Builds a user message that includes the row's existing label / verbKey / shelfKey / URL / description for context.
3. Calls SAP AI Core via the orchestration SDK (`@sap-ai-sdk/orchestration`) with `response_format` pinned to JSON for `{ tagline, whyItMatters }`.
4. Returns `{ tagline, whyItMatters, costUsd }`.

Failure modes are surfaced to the action handler which writes a per-row `PipelineLogItem` (`severity: ERROR` if `503` or model parse error, `WARN` if a single row in the batch failed). Successful generations flip `authoringStatus = 'AI_SEEDED'`.

---

## Vue islands

Two components under [hugo-apps/src/homepage-explainers/](../../../hugo-apps/src/homepage-explainers/):

### `verb-flip-tile`

Used on the homepage verb spine and the verb sub-page headers. Renders a clickable card that flips on click (CSS 3D transform) to show:

- Front: icon + label
- Back: tagline + whyItMatters

Hugo attaches via:

```html
<div data-island="verb-flip-tile" data-verb-key="LEARN"> ... </div>
```

Each instance reads the matching row from `hugo/data/verb_definitions.json` (verb tiles) or `hugo/data/shelf_definitions.json` (shelf headers on verb sub-pages) using the `verbKey` / `shelfKey` attribute.

### `link-explainer-popover`

Used on the directory footer and verb sub-page link cards. Renders an `ⓘ` icon that opens a hover/click popover with the link's tagline + whyItMatters.

Hugo attaches via:

```html
<li data-island="link-explainer-popover" data-shelf-entry-id="<uuid>"> ... </li>
```

Each instance reads the matching shelf entry from `hugo/data/homepage_shelves.json`.

Both islands gracefully degrade when their backing data is blank — they don't render the flip affordance / `ⓘ` icon at all if `tagline` is empty, so a half-seeded DB doesn't show empty popovers.

---

## Admin UI

Three admin entry points, all under the existing admin shell at `/admin-ui/`:

### `/admin-ui/#verb-definitions`

Fiori Elements app over the 6-row `VerbDefinitions` entity. List Report + Object Page. Per-row "Regenerate" action button on the Object Page header.

### `/admin-ui/#shelf-definitions`

Same shape, 4-row `ShelfDefinitions` entity.

### `/admin-ui/#homepage`

The existing Homepage Object Page app gains an **Explainer** facet (per shelf-entry Object Page). The Object Page header has three new bound action buttons:

- **Generate (blanks only)** — fills `BLANK` rows; skips `REVIEWED`. Default bulk action.
- **Generate (all)** — destructive-confirm dialog; overwrites everything including `REVIEWED`.
- **Regenerate this entry** — per-row action on the Object Page (Object Page header level — appears on a single shelf-entry's Object Page).

The admin **shell** ([app/admin-shell/](../../../app/admin-shell/)) groups the three apps under a new **Explainers** side-nav heading containing **Verb Definitions** / **Shelf Definitions** / **Homepage Shelves**.

### Bulk Mark-reviewed actions (#790)

For clearing a backlog of `AI_SEEDED` rows after a bulk regeneration, the ListReport of all three explainer apps exposes a **Mark selected as reviewed** multi-select action (`requiresSelection: true`). It calls one of three unbound `AdminService` actions:

| Action | Entity |
|---|---|
| `bulkMarkVerbExplainerReviewed`       | `VerbDefinitions`  |
| `bulkMarkShelfExplainerReviewed`      | `ShelfDefinitions` |
| `bulkMarkShelfEntryExplainerReviewed` | `HomepageShelves`  |

Each accepts `{ ids: string[] }` and returns `{ processed, skipped, cost: "$0.00" }`. The server-side filter in [`srv/admin-service.js`](../../../srv/admin-service.js) (`runBulkMarkReviewed`) selects the requested IDs, keeps only the rows with `authoringStatus = 'AI_SEEDED'`, and updates them to `'REVIEWED'` in a single `UPDATE … WHERE ID IN (…)`. `BLANK` rows (no content to review yet), already-`REVIEWED` rows (no-op), and IDs not present in the DB all roll into one `skipped` count. No confirm dialog — the flip is reversible via per-row Regenerate.

### Cost surfacing

Every generate action's success toast includes the measured cost: `"AI-seeded 4 shelves. Cost: $0.04."` This is a deliberate "this spends money" signal so the operator notices accidental bulk re-runs.

---

## Authoring workflow

The expected lifecycle for a new BTP environment:

1. **Schema deploy** — entities + seed CSVs land (`VerbDefinitions` 6 rows + `ShelfDefinitions` 4 rows + `HomepageShelves` ~60 rows, all `BLANK`).
2. **Bulk seed (verbs)** — admin presses "Generate (blanks only)" on the Verb Definitions list page. 6 rows transition `BLANK → AI_SEEDED`. ~$0.06.
3. **Bulk seed (shelves)** — same on Shelf Definitions. 4 rows. ~$0.04.
4. **Bulk seed (shelf entries)** — admin presses the equivalent button in the Homepage Shelves admin UI. ~60 rows. ~$0.60.
5. **Editorial review** (recommended for verbs only) — a human reads each verb's tagline + whyItMatters, edits where needed, transitions to `REVIEWED`. ~30 minutes.
6. **Optional spot-checks** — sample ~10 shelf entries, fix anything obviously wrong, mark `REVIEWED`. Leave the rest as `AI_SEEDED`.
7. **Trigger one rebuild** — admin save already debounce-dispatches `rebuild-content.yml`, but an explicit dispatch is harmless.

After step 4, popovers are visitor-observable. Steps 5-6 are quality polish.

---

## Failure modes

| Failure | Behavior |
|---|---|
| Empty / blank rows on a fresh deploy | Vue islands omit the flip affordance entirely; verb spine and link list render exactly as they did before #759. |
| `/build/verb-definitions` returns `[]` (no admin reads have ever happened in this subaccount) | Fetcher logs a warning and writes `{ verbs: [], buildAt: ... }` to JSON. Hugo build doesn't crash. |
| AI Core 503 / network error during generation | Action returns the partial result with `errorDetails`; per-row `PipelineLogItem` rows record which rows failed. Operator retries. |
| `AICORE_EXPLAINER_GENERATOR_DISABLED=true` set during incident | All three actions return 503 with the env-var name in the response body. Pre-existing content (any `AI_SEEDED` / `REVIEWED` rows) keeps rendering normally. |
| Model returns invalid JSON | Action surfaces a `WARN` log item, leaves the row's `authoringStatus` unchanged, and the operator retries the row individually. |
| `tagline` in DB exceeds `String(140)` (unlikely — CAP enforces) | CDS schema validation rejects the save with a 400. |

---

## Related runbooks

- [Homepage architecture](homepage.md) — the broader page anatomy this layers on top of
- [Rebuild content workflow](../operations/rebuild-content-workflow.md) — `catalog-only` rebuild mode handles all three entities
- AI quizzes spec ([2026-06-05-208-ai-authored-quizzes-design.md](../../superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md)) — pattern source for the AI orchestration, cost cap, kill switch, and hybrid-AI test gating
- `CLAUDE.md` > "Gotchas" — `AICORE_EXPLAINER_GENERATOR_DISABLED` env-var details
