# Mission "Temporarily Unavailable" Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual per-mission "Temporarily Unavailable" switch that badges the mission's cards and removes its child path-item links, while leaving the mission's own content reachable.

**Architecture:** New `temporarilyUnavailable` boolean + `unavailableReason` string on `Missions` in CDS. The flag is threaded through the build-time card pipeline (`/build/catalog` → `Mission` type → `browse.json` → both card templates) to show a badge and is used by the navigator/mission-detail feeds to suppress child links. Admin sets it via the Fiori Mission Editor. Propagation is rebuild-gated (same as every other mission edit).

**Tech Stack:** SAP CAP (Node.js, CDS), Fiori Elements (annotations), TypeScript build pipeline, Hugo partials + Vue 3 (vitest).

**Spec:** `docs/superpowers/specs/2026-10-20-mission-disable-path-design.md`

## Global Constraints

- Field names, verbatim: `temporarilyUnavailable : Boolean default false;` and `unavailableReason : String(500);` on `com.sap.developers.ims.Missions`.
- Badge copy, verbatim: **Temporarily Unavailable**.
- `temporarilyUnavailable` must NOT be added to any publish-style write guard — a normal Admin writes it. `_guardPublished` (`srv/admin-service.js:2473-2501`) is field-specific to `published`; leave it untouched.
- A disabled mission stays `published: true`; the new flag is an additional gate, never a replacement for `published`.
- The two mission-card templates (`hugo/layouts/partials/browse/_partials/card-mission.html` and `hugo-apps/src/shared/cards/MissionCard.vue`) must stay parity-equal (post-canonicalization: `data-v-*`, HTML comments, `&middot;`, and whitespace are normalized away — only element/class/text content must match). Any badge markup goes in BOTH, and the fixture `card-mission.expected.html` must be regenerated.
- Badge/link scope is the **build-time** path only (`browse.json`, served by `/browse/` and `/tutorial-navigator/` SSR). Do NOT extend the runtime `MissionRef` plumbing (builder call — see Task 4 note).
- Suppressing links must NOT empty the tutorial set used to derive the card's `level`/`time`/`tutorialCount`/`primaryTag` — those come from bucketed `TutorialNavEntry` rows, independent of the flag. The flag only adds a badge property and gates the link feeds.
- The mission's own detail page must still load — only its child `items[]` are emptied.

## Review Focus

- **Disabled mission with a direct URL still loads (content visible).** Owned by Task 5 — its test asserts the mission-detail handler returns `200` with `items: []`, not `404`.
- **Disabled mission's nested-group child links don't leak through the navigator.** Owned by Task 6 — `navigator-catalog.js` has a *second* GROUP-link path beyond the view; its test asserts a disabled mission contributes no nested-group links.
- **`temporarilyUnavailable: false`/absent behaves exactly as today (no badge, links present).** Owned by Task 4 — card test asserts no badge property/markup when the flag is falsy.
- **A normal (non-SuperAdmin) Admin can set the flag.** Owned by Task 3 — note in the task verifies the guard is not extended; no code change means no new restriction (covered by inspection, not a new auth test, since the guard is field-name-specific).
- **`unavailableReason` round-trips through the catalog without breaking existing card output.** Owned by Task 4 — parity test + existing browse-channel tests must still pass with the new optional fields absent.

---

### Task 1: Add schema fields

**Files:**
- Modify: `db/schema.cds:70-95` (entity `Missions`, adjacent to `published` at `:88`)

**Interfaces:**
- Produces: two new columns on `com.sap.developers.ims.Missions` — `temporarilyUnavailable : Boolean` (default `false`) and `unavailableReason : String(500)`. Consumed by Tasks 2, 3, 5, 6.

- [ ] **Step 1: Add the fields** — in `entity Missions`, immediately after `published : Boolean default false;` (line 88), add:

```cds
  temporarilyUnavailable    : Boolean default false;
  unavailableReason         : String(500);
```

- [ ] **Step 2: Verify the model compiles** — Run: `npx cds compile db/schema.cds --to sql > /dev/null` (wrap in `scripts/quiet-run.sh` if noisy). Expected: no error; exit 0.

- [ ] **Step 3: Commit**

```bash
git add db/schema.cds
git commit -m "feat(#2864): add temporarilyUnavailable + unavailableReason to Missions"
```

---

### Task 2: Emit the flag from /build/catalog and the Mission type

**Files:**
- Modify: `scripts/parsers/types.ts:268-278` (the `Mission` interface)
- Modify: `srv/lib/build-catalog.js:53-63` (`missionList.map`)
- Test: `test/unit/srv/build-catalog-unavailable.test.js` (new; match the harness used by sibling `srv/lib` unit tests — check `test/unit/srv/` for an existing build-catalog test to mirror; if none, use the project's default unit runner as configured in `package.json` `test` script)

**Interfaces:**
- Consumes: schema fields from Task 1.
- Produces: `Mission` type gains `temporarilyUnavailable?: boolean` and `unavailableReason?: string`; `/build/catalog` mission objects carry both. Consumed by Task 4 (card assembly reads `mMeta.temporarilyUnavailable`).

- [ ] **Step 1: Write the failing test** — assert the catalog handler maps the flag. Build a published mission with `temporarilyUnavailable: true, unavailableReason: 'maintenance'` in the test DB, call the catalog build, and assert the emitted mission object has `temporarilyUnavailable === true` and `unavailableReason === 'maintenance'`. (Mirror the setup of the nearest existing `build-catalog` unit test; if the handler isn't unit-testable in isolation, test the pure `missionList.map` shape by extracting/asserting on a representative row.)

```js
// shape of the assertion
expect(missionObj.temporarilyUnavailable).toBe(true)
expect(missionObj.unavailableReason).toBe('maintenance')
```

- [ ] **Step 2: Run it, verify it fails** — Run the new test. Expected: FAIL (field undefined).

- [ ] **Step 3: Add the fields to the `Mission` interface** (`scripts/parsers/types.ts`), after `categorySlugs?: string[]`:

```ts
  temporarilyUnavailable?: boolean
  unavailableReason?: string
```

- [ ] **Step 4: Thread them through `missionList.map`** (`srv/lib/build-catalog.js:53-63`) — add to the mapped object:

```js
    temporarilyUnavailable: m.temporarilyUnavailable === true,
    unavailableReason: m.unavailableReason || undefined,
```

- [ ] **Step 5: Run the test, verify it passes.**

- [ ] **Step 6: Commit**

```bash
git add scripts/parsers/types.ts srv/lib/build-catalog.js test/unit/srv/build-catalog-unavailable.test.js
git commit -m "feat(#2864): carry temporarilyUnavailable through /build/catalog + Mission type"
```

---

### Task 3: Surface the toggle in the Admin Mission Editor

**Files:**
- Modify: `app/admin-annotations.cds:117-136` (label block) and `:138-173` (`@UI` block)

**Interfaces:**
- Consumes: schema fields from Task 1 (auto-projected through `srv/admin-service.cds:152` `*`).
- Produces: editable `temporarilyUnavailable` + `unavailableReason` on the Missions ObjectPage, and a `temporarilyUnavailable` list column.

- [ ] **Step 1: Add labels** — in `annotate AdminService.Missions with { … }`, after the `published @Common.Label: 'Published';` line (`:129`):

```cds
  temporarilyUnavailable @Common.Label: 'Temporarily Unavailable';
  unavailableReason      @Common.Label: 'Unavailable Reason'  @UI.MultiLineText;
```

- [ ] **Step 2: Add the list column** — in `@UI.LineItem`, after `{ Value: published, @UI.Importance: #High }` (`:151`):

```cds
      { Value: temporarilyUnavailable },
```

- [ ] **Step 3: Add the form fields** — in `@UI.FieldGroup#General.Data`, after `{ Value: published, @UI.FieldControl: publishedFieldControl }` (`:168`):

```cds
      { Value: temporarilyUnavailable },
      { Value: unavailableReason },
```

- [ ] **Step 4: Confirm the write guard is NOT extended** — inspect `srv/admin-service.js:2473-2501` (`_guardPublished`). Verify it only acts on `'published' in req.data`; confirm no change is needed so a normal Admin can write the new flag. (No code change; this is a verification step.)

- [ ] **Step 5: Verify annotations compile** — Run: `npx cds compile srv --to edmx > /dev/null` (quiet-run if noisy). Expected: exit 0, no annotation error referencing `temporarilyUnavailable`/`unavailableReason`.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(#2864): expose Temporarily Unavailable toggle in Mission Editor"
```

---

### Task 4: Badge on the card (build-time + both templates + parity)

**Files:**
- Modify: `scripts/fetch-tutorials.ts:2021-2038` (`BrowseCardItem`) and `:2204-2230` (mission literal)
- Modify: `hugo-apps/src/shared/types.ts:20-37` (`CardItem`)
- Modify: `hugo/layouts/partials/browse/_partials/card-mission.html`
- Modify: `hugo-apps/src/shared/cards/MissionCard.vue`
- Modify: `hugo-apps/src/browse/__tests__/fixtures/cards.fixtures.json` (add flag to `mission` fixture)
- Regenerate: `hugo-apps/src/browse/__tests__/fixtures/card-mission.expected.html` (via `tools/regen-card-parity-fixtures.sh`)
- Test: `scripts/__tests__/fetch-tutorials-browse-channel.test.ts` (add cases) + `hugo-apps/src/browse/__tests__/card-template-parity.test.ts` (fixture already exercises both templates)

**Interfaces:**
- Consumes: `Mission.temporarilyUnavailable` / `unavailableReason` from Task 2 (`mMeta` lookup in `buildAllCards`).
- Produces: `BrowseCardItem` / `CardItem` gain `temporarilyUnavailable?: boolean` and `unavailableReason?: string`; mission cards render a badge element when the flag is truthy.

**Builder note (runtime scope):** The runtime navigator (`TutorialNavigator.vue`, mission literal `:119-141`) builds its card from a `MissionRef` (`{id,slug,title}` only — it doesn't even carry `categorySlugs`). Do NOT extend `MissionRef`/the navigator seed to thread the flag at runtime. The badge is baked into `browse.json` and rendered server-side on first paint for both `/browse/` and `/tutorial-navigator/`; the Vue `MissionCard.vue` must still render the badge from `item.temporarilyUnavailable` so the parity test holds and hydration is identical. This is the minimal correct layer given rebuild-gated propagation.

- [ ] **Step 1: Write the failing build-time test** — in `fetch-tutorials-browse-channel.test.ts`, add a case: construct `const mission: Mission = { imsId: 1, slug: 'x', title: 'X', description: '', level: 'beginner', time: 60, icon: '', tasksCount: 1, temporarilyUnavailable: true, unavailableReason: 'maint' }` and `makeTut({ missionId: 1, missionTitle: 'X' })`, call `buildAllCards([tut],[mission],noHierarchies,noGroups,emptyMetaMap)`, assert:

```ts
    const mCard = cards.find(c => c.type === 'mission')
    expect(mCard?.temporarilyUnavailable).toBe(true)
    expect(mCard?.unavailableReason).toBe('maint')
```

  And a negative case: a mission without the flag yields `mCard?.temporarilyUnavailable` falsy.

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Add fields to `BrowseCardItem`** (`scripts/fetch-tutorials.ts:2021-2038`) and **`CardItem`** (`hugo-apps/src/shared/types.ts:20-37`), both after `createdAt?`/`updatedAt?`:

```ts
  temporarilyUnavailable?: boolean
  unavailableReason?: string
```

- [ ] **Step 4: Populate them in the mission literal** (`scripts/fetch-tutorials.ts:2204-2230`), after `categorySlugs`:

```ts
        temporarilyUnavailable: mMeta?.temporarilyUnavailable === true,
        unavailableReason: mMeta?.unavailableReason,
```

- [ ] **Step 5: Run the build-time test, verify it passes.**

- [ ] **Step 6: Add the badge to both templates.** In `MissionCard.vue`, immediately after the `nav-card__type--mission` div:

```html
      <div v-if="item.temporarilyUnavailable" class="nav-card__unavailable-badge">Temporarily Unavailable</div>
```

  In `card-mission.html`, in the same position (after the `MISSION` type div):

```html
  {{- if $item.temporarilyUnavailable }}<div class="nav-card__unavailable-badge">Temporarily Unavailable</div>{{ end -}}
```

  Add a `.nav-card__unavailable-badge` rule to `hugo-apps/src/shared/cards/card.css` (reuse existing badge/chip visual conventions; builder's CSS call).

- [ ] **Step 7: Add the flag to the mission parity fixture** — in `cards.fixtures.json`, set `"temporarilyUnavailable": true` on the `mission` object so the parity test exercises the badge branch.

- [ ] **Step 8: Regenerate the Hugo fixture** — Run: `bash tools/regen-card-parity-fixtures.sh` (requires `hugo` on PATH). Expected: `card-mission.expected.html` updated to include the badge element.

- [ ] **Step 9: Run the parity + browse-channel tests, verify they pass** — Run the vitest suites for `card-template-parity.test.ts` and `fetch-tutorials-browse-channel.test.ts`. Expected: PASS (Vue and Hugo render the badge identically post-canonicalization).

- [ ] **Step 10: Commit**

```bash
git add scripts/fetch-tutorials.ts hugo-apps/src/shared/types.ts hugo/layouts/partials/browse/_partials/card-mission.html hugo-apps/src/shared/cards/MissionCard.vue hugo-apps/src/shared/cards/card.css hugo-apps/src/browse/__tests__/fixtures/cards.fixtures.json hugo-apps/src/browse/__tests__/fixtures/card-mission.expected.html scripts/__tests__/fetch-tutorials-browse-channel.test.ts
git commit -m "feat(#2864): Temporarily Unavailable badge on mission cards"
```

---

### Task 5: Suppress links in the mission-detail feed (content stays visible)

**Files:**
- Modify: `srv/lib/branch/mission-detail.js:37-38` (right after the mission load)
- Test: `test/unit/srv/mission-detail-unavailable.test.js` (new; mirror an existing `srv/lib/branch` or mission-detail test harness if one exists)

**Interfaces:**
- Consumes: `mission.temporarilyUnavailable` (already selected — `SELECT.one.from(Missions)` has no `.columns`, so the field is present once Task 1 lands).
- Produces: for a disabled mission, the feed returns `{ missionSlug, items: [] }` with HTTP 200 (page shell reachable, no onward links).

- [ ] **Step 1: Write the failing test** — a disabled mission (`temporarilyUnavailable: true`) with at least one completion path + tutorial item returns status 200 and `body.items` length 0; a normal mission returns its items as today.

```js
// disabled mission
expect(res.statusCode).toBe(200)
expect(body).toEqual({ missionSlug: 'x', items: [] })
```

- [ ] **Step 2: Run it, verify it fails** (currently returns the tutorial items).

- [ ] **Step 3: Add the guard** — in `mission-detail.js`, immediately after the `if (!mission) return res.status(404)…` line (`:38`):

```js
    if (mission.temporarilyUnavailable) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ missionSlug: slug, items: [] });
    }
```

- [ ] **Step 4: Run the test, verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/mission-detail.js test/unit/srv/mission-detail-unavailable.test.js
git commit -m "feat(#2864): mission-detail feed returns no items for disabled missions"
```

---

### Task 6: Suppress links in the navigator (view + nested-group path)

**Files:**
- Modify: `db/views.cds:76-95` (`NavigatorCatalog` — project the flag, filter it)
- Modify: `srv/lib/navigator-catalog.js:221-224` (nested-group mission SELECT)
- Test: `test/unit/srv/navigator-catalog-unavailable.test.js` (new)

**Interfaces:**
- Consumes: schema fields from Task 1.
- Produces: a disabled mission contributes no tutorial links (view `where`) and no nested-group links (JS filter) to the navigator catalog.

- [ ] **Step 1: Write the failing test** — seed a published-but-`temporarilyUnavailable` mission with a tutorial item and a nested GROUP item; call the navigator catalog builder; assert no catalog entry references that mission's slug and no nested-group link flows from it. A normal published mission still produces its entries.

- [ ] **Step 2: Run it, verify it fails** (links currently flow — only `published` is filtered).

- [ ] **Step 3: Filter the view** — in `db/views.cds` `NavigatorCatalog`, extend the `where` clause:

```cds
    where item.taskType = 'TUTORIAL' and tut.slug is not null
      and mission.published = true and mission.temporarilyUnavailable = false;
```

  (If any view row needs the flag value, also add `mission.temporarilyUnavailable as missionTemporarilyUnavailable` to the projection — only if the test shows it's needed; otherwise the `where` is sufficient.)

- [ ] **Step 4: Filter the nested-group path** — in `navigator-catalog.js:221-224`, add the flag to the mission SELECT's `.where`:

```js
      ? await SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug', 'published', 'temporarilyUnavailable').where({ ID: { in: missionIds }, published: true, temporarilyUnavailable: false })
```

  Confirm the `missionById` map then excludes disabled missions so their nested-group refs are dropped. (Verify whether `temporarilyUnavailable: false` matches rows where the column is `null` on legacy data — if the default didn't backfill, use `{ '!=': true }` instead. Builder checks against a migrated row.)

- [ ] **Step 5: Run the test, verify it passes.**

- [ ] **Step 6: Commit**

```bash
git add db/views.cds srv/lib/navigator-catalog.js test/unit/srv/navigator-catalog-unavailable.test.js
git commit -m "feat(#2864): navigator suppresses links for disabled missions"
```

---

### Task 7: Full test sweep + cds build

**Files:** none (verification task).

- [ ] **Step 1: Run the unit suite** — Run: `scripts/quiet-run.sh npm test`. Expected: PASS (new tests green, no regressions). Drill into `.quiet-logs/` only if the summary shows a failure.

- [ ] **Step 2: Production build sanity** — Run: `scripts/quiet-run.sh npx cds build --production`. Expected: exit 0 (schema + annotations + views compile for deploy).

- [ ] **Step 3: Confirm line endings unchanged** (Windows worktree) — Run: `git diff --stat` and spot-check with `file db/schema.cds db/views.cds srv/lib/navigator-catalog.js`. Expected: no CRLF flip on edited LF files; normalize via Node if any flipped.

- [ ] **Step 4: Commit any fixups**, then the branch is ready for PR to `DEV`.

---

## Notes for the executor

- PRs target `DEV` (not `main`); open with `gh pr create`.
- This is model + build-pipeline + annotations only — no deploy is required to merge. The badge/link behavior goes live on the next content rebuild after deploy (rebuild-gated, by design).
- Groups have a parallel `published` field (`db/schema.cds:102`) — the issue is mission-path-level only; do NOT add the flag to Groups unless asked.
