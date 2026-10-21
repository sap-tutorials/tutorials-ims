# Path-Item Temporarily-Unavailable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework #2864 so "Temporarily Unavailable" is a per-path-item (single tutorial) flag that instantly greys out + delinks that tutorial on the live SSR mission page, replacing the useless mission-header-level flag.

**Architecture:** Revert the mission-level fields + all wiring; add `temporarilyUnavailable`/`unavailableReason` to `CompletionPathItems`; edit via the FE path-item detail form; suppress the link in the request-time SSR mission render (`catalog-data.js` → `catalog-renderer.js`) so the effect is instant with no content rebuild.

**Tech Stack:** SAP CAP (Node.js, CDS), SAP HANA, Fiori Elements (annotations), server-side-rendered mission pages (`packages/content/`), Vitest unit tests.

**Spec:** `docs/superpowers/specs/2026-10-21-path-item-temporarily-unavailable-design.md`

## Global Constraints

- Feature PR targets **DEV**, never main; open a PR, never direct-merge. Branch is already rebased on `origin/DEV`.
- Never write raw SQL — use `cds.ql`/CQL. (SSR LOB rule doesn't apply: no BLOB here.)
- Never SELECT a HANA BLOB alongside metadata — N/A here; these are scalar columns.
- Correlation key for the flag is the **path item** (`(path_ID, tutorial_ID)`), NOT `tutorial_ID` alone — the same tutorial appears in multiple paths/missions.
- Admin edit is on the **path-item detail form / FieldGroup**, not inline in the Path Items table (no manifest/fragment work).
- Content is NOT removed; only the link is suppressed + the row styled. Title text stays visible.
- Do NOT deploy. Local verify is the completion gate.
- Migration tables regenerate via repo convention (`cds build`/`npm run build:db` as used by bad6118e1); commit the regenerated `db/src/*.hdbmigrationtable` + `db/last-dev/csn.json`.

## Review Focus

- **Same tutorial in two paths, one flagged** — only the flagged path-item's row greys out; the other stays clickable. (Task 4 correlation test.)
- **Flag set but `unavailableReason` null** — badge still renders; no empty/`undefined` tooltip attribute. (Task 5 render test, negative-reason case.)
- **`unavailableReason` containing HTML/quotes** — escaped in the `title`/`aria-label` attribute (XSS/attribute-break). (Task 5 render test asserts `escapeHtml`.)
- **Mission-level flag removed cleanly** — no dangling reference crashes the browse card build, navigator catalog, or admin load after revert. (Task 1 full `npm test` + grep-clean gate.)
- **Flag absent (default false)** — normal clickable `<a class="tutorial-link">` unchanged; zero behavior change for the 99% case. (Task 5 render test, negative case.)

---

### Task 1: Revert the mission-level #2864 feature

Fully remove `temporarilyUnavailable`/`unavailableReason` from the `Missions` path. One coherent commit; after it, `grep -rn temporarilyUnavailable` returns **nothing** outside generated `hugo/public*/**`.

**Files:**
- Modify: `db/schema.cds:89-90` (drop both fields from `entity Missions`)
- Modify: `db/views.cds:97` (drop the `mission.temporarilyUnavailable` filter clause from the view WHERE)
- Modify: `srv/lib/navigator-catalog.js:223` (remove `'temporarilyUnavailable'` column + the `temporarilyUnavailable: { '!=': true }` where-key)
- Modify: `srv/lib/branch/mission-detail.js:40-44` (remove the mission-level early-return block)
- Modify: `srv/lib/build-catalog.js:63` (remove the `temporarilyUnavailable:` emit line)
- Modify: `scripts/parsers/types.ts:283-284` (remove both optional fields)
- Modify: `scripts/fetch-tutorials.ts:2079-2080` + `:2272-2273` (remove type fields + the mission-literal emit)
- Modify: `hugo-apps/src/shared/types.ts:37-38` (remove both fields)
- Modify: `hugo-apps/src/shared/cards/MissionCard.vue:44` (remove the badge `<div v-if=...>`)
- Modify: `hugo/layouts/partials/browse/_partials/card-mission.html:31` (remove the badge line)
- Modify: `app/admin-annotations.cds:130-131,154,172-173` (remove Missions labels + LineItem/FieldGroup `{ Value: ... }` entries)
- Modify: `srv/page-fallback/page-browse.html`, `srv/page-fallback/page-tutorial-navigator.html` (remove any `temporarilyUnavailable` references)
- Delete: `test/unit/srv/mission-detail-unavailable.test.js`, `test/unit/srv/navigator-catalog-unavailable.test.js`
- Modify: `scripts/__tests__/fetch-tutorials-browse-channel.test.ts` (remove the two mission-badge cases added by f0fac77bf), `hugo-apps/src/shared/cards/__tests__/fixtures/cards.fixtures.json` (remove `temporarilyUnavailable:true` from mission fixture)
- Regenerate: `hugo-apps/src/shared/cards/__tests__/fixtures/*.expected.html` + `browse-page-1.html` (via the repo's regen-card-parity-fixtures script), `db/src/com.sap.developers.ims.Missions.hdbmigrationtable`, `db/last-dev/csn.json`
- **Keep:** `hugo-apps/src/shared/cards/card.css:210` `.nav-card__unavailable-badge` rule (reused by Task 5)

**Interfaces:**
- Produces: a clean `CompletionPathItems`-free, Missions-flag-free baseline. No symbols other tasks consume.

- [ ] **Step 1: Remove all Missions-level source references** at the file:line targets above (schema, views, navigator-catalog, mission-detail, build-catalog, types.ts, fetch-tutorials.ts, MissionCard.vue, card-mission.html, admin-annotations, page-fallback). Keep the CSS rule.
- [ ] **Step 2: Delete the two mission-level test files and revert the mission-badge test cases + fixtures.** Regenerate the card parity `*.expected.html` via the repo's regen script.
- [ ] **Step 3: Regenerate DB migration tables** (`cds build` per repo convention) so the dropped Missions columns are reflected in `Missions.hdbmigrationtable` + `last-dev/csn.json`.
- [ ] **Step 4: Grep-clean gate.** Run `git grep -n temporarilyUnavailable -- ':!hugo/public*'` — Expected: **no matches** (generated public artifacts excluded; they're overwritten by build:all).
- [ ] **Step 5: Run the full unit suite.** Run: `npm test` — Expected: PASS (mission-level tests gone, nothing references the dropped fields).
- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "revert(#2864): remove mission-header-level temporarilyUnavailable (wrong level)"
```

---

### Task 2: Add `temporarilyUnavailable` + `unavailableReason` to `CompletionPathItems`

**Files:**
- Modify: `db/schema.cds` — `entity CompletionPathItems` (the block at ~:471 after Task 1 shifts lines)
- Regenerate: `db/src/com.sap.developers.ims.CompletionPathItems.hdbmigrationtable`, `db/last-dev/csn.json`
- Test: `test/unit/srv/completion-path-item-unavailable.test.js` (new)

**Interfaces:**
- Produces: `CompletionPathItems.temporarilyUnavailable : Boolean default false` and `CompletionPathItems.unavailableReason : String(500)`. The admin projection (`AdminService.CompletionPathItems`, already `SELECT *`) auto-exposes them. Consumed by Tasks 3 (admin), 4 (SSR data), 5 (render).

- [ ] **Step 1: Write the failing test** `test/unit/srv/completion-path-item-unavailable.test.js` — boots CAP in-memory, inserts a `CompletionPathItems` row with `temporarilyUnavailable:true, unavailableReason:'Down for maintenance'`, reads it back via `AdminService.CompletionPathItems`, asserts both fields round-trip and that a row inserted without them defaults `temporarilyUnavailable` to `false`.
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/srv/completion-path-item-unavailable.test.js` — Expected: FAIL (unknown field `temporarilyUnavailable`).
- [ ] **Step 3: Add the two fields** to `entity CompletionPathItems` in `db/schema.cds`:
```cds
  temporarilyUnavailable    : Boolean default false;
  unavailableReason         : String(500);
```
- [ ] **Step 4: Regenerate migration tables** (`cds build` per repo convention).
- [ ] **Step 5: Run test to verify it passes.** Run: `npx vitest run test/unit/srv/completion-path-item-unavailable.test.js` — Expected: PASS.
- [ ] **Step 6: Commit**
```bash
git add db/schema.cds db/src db/last-dev test/unit/srv/completion-path-item-unavailable.test.js
git commit -m "feat(#2864): add temporarilyUnavailable + unavailableReason to CompletionPathItems"
```

---

### Task 3: Admin UI — toggle + reason on the path-item detail form

**Files:**
- Modify: `app/admin-annotations.cds` — the `annotate AdminService.CompletionPathItems with { ... }` label block (~:247) and the `@UI.FieldGroup#TaskDetails` block (~:76 in the `with @UI` section)

**Interfaces:**
- Consumes: Task 2's fields (auto-projected via `SELECT *`).
- Produces: editable `Temporarily Unavailable` (Boolean) + `Unavailable Reason` (MultiLineText) on the path-item Object Page detail form. No LineItem change (not inline in table). No manifest change.

- [ ] **Step 1: Add field labels** in the `annotate AdminService.CompletionPathItems with { ... }` block:
```cds
  temporarilyUnavailable @Common.Label: 'Temporarily Unavailable';
  unavailableReason      @Common.Label: 'Unavailable Reason'  @UI.MultiLineText;
```
- [ ] **Step 2: Add both to the `@UI.FieldGroup#TaskDetails` Data array** (the detail form facet) as:
```cds
      { Value: temporarilyUnavailable },
      { Value: unavailableReason },
```
- [ ] **Step 3: Verify CDS compiles.** Run: `npx cds compile srv/admin-service.cds --to csn >/dev/null` — Expected: compiles with no error about these annotations. (If the pre-existing `developer-service-mcp.cds` duplicate-definition error blocks whole-model compile, compile just the admin model file as shown.)
- [ ] **Step 4: Commit**
```bash
git add app/admin-annotations.cds
git commit -m "feat(#2864): expose path-item unavailable toggle on admin detail form"
```

---

### Task 4: SSR data — correlate the per-path-item flag into `loadMissionContext`

**Files:**
- Modify: `packages/content/catalog-data.js` — `loadMissionContext` (the `CompletionPathItems` SELECT at ~:192 and the tutorial-object emit)
- Modify (only if needed): `packages/content/catalog-mission-hierarchy.js` — `assembleMissionHierarchy` to carry a per-path-item map through; and its callers/tests if widened
- Test: `test/unit/content/mission-context-unavailable.test.js` (new)

**Interfaces:**
- Consumes: Task 2's `CompletionPathItems.temporarilyUnavailable`/`unavailableReason`.
- Produces: each tutorial object in the returned `groups[].tutorials[]` carries `temporarilyUnavailable: boolean` and `unavailableReason: string|undefined`, correlated by `(path_ID, tutorial_ID)`. Consumed by Task 5's renderer.

- [ ] **Step 1: Write the failing test** `test/unit/content/mission-context-unavailable.test.js` — stub/seed a mission whose first path has two tutorials, tutorial A flagged `temporarilyUnavailable:true` in THIS path, same tutorial A appearing unflagged in a second path; assert `loadMissionContext(slug)` returns A's tutorial object in the first group with `temporarilyUnavailable===true` and the reason, and in the second group with `temporarilyUnavailable===false`. (Pins the Constraint-#2 keying.)
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/content/mission-context-unavailable.test.js` — Expected: FAIL (field absent / cross-flagged).
- [ ] **Step 3: Add the two columns** to the `CompletionPathItems` `.columns(...)` SELECT in `loadMissionContext` (currently `'group_ID','tutorial_ID','taskType','itemOrder','path_ID'`), build a `Map` keyed `` `${path_ID}:${tutorial_ID}` `` → `{ temporarilyUnavailable, unavailableReason }`, and when emitting each tutorial object into its group, stamp the two fields from that map using the item's own `path_ID`+`tutorial_ID`. Thread through `assembleMissionHierarchy` only if the tutorial projection loses the path context; prefer correlating in the caller to keep blast radius small (builder's call per spec).
- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run test/unit/content/mission-context-unavailable.test.js` — Expected: PASS.
- [ ] **Step 5: Run the content unit suite** to catch helper-contract regressions. Run: `npx vitest run test/unit/content` — Expected: PASS.
- [ ] **Step 6: Commit**
```bash
git add packages/content/catalog-data.js packages/content/catalog-mission-hierarchy.js test/unit/content/mission-context-unavailable.test.js
git commit -m "feat(#2864): surface per-path-item unavailable flag in loadMissionContext"
```

---

### Task 5: SSR render — grey out, delink, badge + tooltip

**Files:**
- Modify: `packages/content/catalog-renderer.js` — `renderMission` per-tutorial emit (the `<a href="/tutorials/${t.slug}${fromParam}" class="tutorial-link">${t.title}</a>` at ~:192)
- Modify: the mission SSR stylesheet (the CSS co-located with the SSR pages; builder locates the disabled-card rule next to existing `.tutorial-link`/`.nav-card__unavailable-badge` usage)
- Test: `test/unit/content/render-mission-unavailable.test.js` (new)

**Interfaces:**
- Consumes: Task 4's per-tutorial `temporarilyUnavailable`/`unavailableReason`.
- Produces: final user-visible HTML. No downstream consumer.

- [ ] **Step 1: Write the failing test** `test/unit/content/render-mission-unavailable.test.js` with three cases on `renderMission`'s HTML output:
  - flagged + reason: output contains the tutorial title but **no** `<a ... class="tutorial-link"` for that tutorial's slug; contains `nav-card__unavailable-badge` text "Temporarily Unavailable"; contains `title="Down &amp; out"` / `aria-label` with the **escaped** reason (seed reason `Down & out` to assert escaping).
  - flagged, reason null: badge present; **no** empty `title=""`/`title="undefined"` attribute.
  - not flagged: the normal `<a href="/tutorials/<slug>..." class="tutorial-link">` is present (regression).
- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run test/unit/content/render-mission-unavailable.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement the conditional emit** in `renderMission`'s `g.tutorials.map(...)`: when `t.temporarilyUnavailable`, render the title in a non-anchor element (e.g. `<span class="tutorial-link tutorial-link--unavailable">`) instead of `<a href>`, append `<span class="nav-card__unavailable-badge">Temporarily Unavailable</span>`, and add `title`/`aria-label` set to `escapeHtml(t.unavailableReason)` **only when** reason is truthy; add `tutorial-card--unavailable` to the card class. Otherwise emit the existing anchor unchanged.
- [ ] **Step 4: Add the disabled-card CSS** (greyed/dimmed, `cursor: default`) alongside the existing badge rule, matching Horizon.
- [ ] **Step 5: Run test to verify it passes.** Run: `npx vitest run test/unit/content/render-mission-unavailable.test.js` — Expected: PASS.
- [ ] **Step 6: Commit**
```bash
git add packages/content/catalog-renderer.js test/unit/content/render-mission-unavailable.test.js
git commit -m "feat(#2864): grey out + delink temporarily-unavailable path items on mission page"
```

---

### Task 6: Regenerate GraphQL SDL + full regression + manual verify

**Files:**
- Regenerate: `srv/graphql/schema.graphql` (via `npm run build:sdl`)

**Interfaces:**
- Consumes: Task 2's schema fields. Produces: updated SDL (not on the render path).

- [ ] **Step 1: Regenerate the SDL.** Run: `npm run build:sdl` — Expected: `schema.graphql` now includes `temporarilyUnavailable`/`unavailableReason` on the `CompletionPathItems` types; no other semantic drift (review the diff).
- [ ] **Step 2: Full unit suite.** Run: `npm test` — Expected: PASS, green across CAP + content + scripts suites.
- [ ] **Step 3: Manual/visual verify (the actual thing).** Start local CAP + SSR (`npm run dev:hybrid` or `cds watch` + the content app per repo convention), flag one path item via the admin Path Items **detail form**, load `/tutorials/mission-<slug>/`: confirm that tutorial's row is greyed, shows the badge, the link is dead, the reason shows as tooltip; un-flag → row clickable again, **no rebuild**. Record what was observed.
- [ ] **Step 4: Commit**
```bash
git add srv/graphql/schema.graphql
git commit -m "chore(#2864): regenerate GraphQL SDL for CompletionPathItems unavailable fields"
```

---

## Follow-up (NOT in this plan)

Tutorial-page right-rail side-nav alt-group branches (`/build/mission/:slug` + `MissionAltGroupHighlight.vue`) do not honor the flag — a disabled tutorial may still show clickable there. File as a tracked issue if observed; out of v1 scope per spec.
