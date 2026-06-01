# Tag Label Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lossy `humanizeTag()` slug-to-title heuristic with a database-backed label registry, restoring legacy AEM-quality tag labels (`SAP S/4HANA Cloud Public Edition` instead of `SAP S 4hana Cloud Public Edition`) on the navigator filter and tutorial cards.

**Architecture:** Add a `label` column to the existing `Tags` entity (already in HANA, edited by the admin Tags app). Seed it once by scraping developers.sap.com legacy filter UI. At Hugo build time, fetch the slug-to-label map from CAP and join it to each tutorial `displayTags`. Split presentation from join keys: introduce a parallel `displayTagSlugs[]` for filter equality, search, and license detection — `displayTags[]` becomes presentation-only. The heuristic survives as a fallback for slugs the registry has not seen yet.

**Tech Stack:** CAP Node.js (db/schema.cds, srv/), HANA HDI deploy, Vue 3 navigator (hugo-apps), TypeScript build scripts (scripts/), Vitest, Hugo, Fiori Elements admin app (sap.fe.templates).

**Key context:**
- Bug confirmed in [hugo-apps/src/navigator/TutorialNavigator.vue:181](../../../hugo-apps/src/navigator/TutorialNavigator.vue#L181) (filter rendering of `displayTags`).
- Root cause: [scripts/parsers/frontmatter-utils.ts:3](../../../scripts/parsers/frontmatter-utils.ts#L3) `humanizeTag()` is slug-only and cannot recover `/`, mid-word capitals, or punctuation.
- Tags entity exists today: [db/schema.cds:167](../../../db/schema.cds#L167) — has `name`, `titlePath`, `mdFormat` but no clean `label`. 208 rows in HANA, with `name` populated as lowercase slug-with-spaces (e.g. "sap s 4hana cloud public edition") — useless as a label.
- `TutorialTags` join table is currently EMPTY in HANA — the navigator gets `displayTags` from `_nav.json` (built by `humanizeTag`), not from the DB. We will keep that build-time-static path but enrich it from the DB.
- Tom directive: NO JSON checked into the repo; labels live in HANA, edited via the existing Tags admin app at `/admin-ui/#tags-display`.

---

## File Structure

**Schema and data:**
- Modify: [db/schema.cds](../../../db/schema.cds) — add `label : String(255)` to `Tags`.
- Modify: [app/admin-annotations.cds](../../../app/admin-annotations.cds) — surface `label` in the Tags Fiori Elements list/object page.
- Modify: [srv/admin-service.cds](../../../srv/admin-service.cds) — Tags projection becomes editable on `label`.
- Create: [scripts/seed-tag-labels.ts](../../../scripts/seed-tag-labels.ts) — one-shot scraper hitting developers.sap.com filter, posting `{ titlePath, label }` upserts to `/admin/Tags`.

**Backend (CAP):**
- Create: [srv/lib/tag-label-map.js](../../../srv/lib/tag-label-map.js) — single source of truth for the slug-to-label lookup. Used by build-side fetcher and `/content/nav`.
- Modify: srv-side route registration (locate during Step 8.1) — expose `/build/tag-labels` (unauthenticated GET, returns flat map keyed by titlePath).
- Modify: [srv/lib/content-store.js:1004-1026](../../../srv/lib/content-store.js#L1004-L1026) — `/content/nav` enriches `displayTags` from `tag-label-map`; emits `displayTagSlugs[]` alongside `displayTags[]`.

**Build-time (TypeScript):**
- Modify: [scripts/parsers/frontmatter-utils.ts](../../../scripts/parsers/frontmatter-utils.ts) — `humanizeTag(rawSlug, registry?)` looks up the registry first, falls back to current heuristic.
- Modify: [scripts/fetch-tutorials.ts](../../../scripts/fetch-tutorials.ts) — fetch the registry from CAP at build start, thread into front-matter generation. Emit both `displayTagSlugs` (raw slugs) and `displayTags` (resolved labels).
- Modify: [scripts/parsers/render-frontmatter.ts:64](../../../scripts/parsers/render-frontmatter.ts#L64) — same dual-emission as above.
- Modify: [scripts/parsers/types.ts](../../../scripts/parsers/types.ts) — add `displayTagSlugs: string[]` to the front-matter type.

**Frontend (Vue 3 navigator):**
- Modify: [hugo-apps/src/shared/types.ts](../../../hugo-apps/src/shared/types.ts) — add `displayTagSlugs: string[]` to `TutorialEntry` and `CardItem`.
- Modify: [hugo-apps/src/shared/license.ts](../../../hugo-apps/src/shared/license.ts) — `requiresLicense(item)` checks `displayTagSlugs.includes('tutorial>license')`.
- Modify: [hugo-apps/src/navigator/TutorialNavigator.vue](../../../hugo-apps/src/navigator/TutorialNavigator.vue) — `availableProducts` keys on slug, renders label; `PRODUCT_TO_TOPICS` rekeyed on slug; product-filter equality uses `displayTagSlugs`.
- Modify: [hugo-apps/src/navigator/useSearch.ts:23](../../../hugo-apps/src/navigator/useSearch.ts#L23) — populate `displayTagSlugs` when enriching from `tutorialsBySlug`.

**Tests:**
- Create: [scripts/__tests__/tag-label-registry.test.ts](../../../scripts/__tests__/tag-label-registry.test.ts) — registry lookup, fallback to heuristic on miss.
- Modify: [test/parsers/render-frontmatter.test.ts](../../../test/parsers/render-frontmatter.test.ts) — assert dual emission.
- Modify: [hugo-apps/src/navigator/useSearch.test.ts](../../../hugo-apps/src/navigator/useSearch.test.ts) — extend fixtures.
- Create: [test/lib/tag-label-map.test.js](../../../test/lib/tag-label-map.test.js) — unit tests for the lookup helper.
- Modify: [test/hybrid/admin-crud.test.js](../../../test/hybrid/admin-crud.test.js) — add `label` to Tags CRUD smoke.

**Docs:**
- Modify: [CLAUDE.md](../../../CLAUDE.md) — Gotchas section.
- Modify: [docs/authors/center-admin.md:196](../../../docs/authors/center-admin.md#L196) — document the new `label` column.

---

## Pre-flight: Set up the worktree

This is multi-PR-sized work touching schema. Per [[feedback-parallel-agents-worktrees]] and Tom standing rule, work in an isolated worktree.

- [ ] **Step 0.1: Create worktree**

```bash
git fetch origin main
git worktree add -b feature/tag-label-registry .worktrees/tag-label-registry origin/main
cd .worktrees/tag-label-registry
npm install
```

- [ ] **Step 0.2: Verify baseline tests pass**

```bash
npm test 2>&1 | tail -20
```

Expected: green (per [[project_main_test_failures]], baseline is 620 passing / 0 failing / 13 skipped). If hangs per [[feedback_worktree_tests_hang]], cap at 3 minutes.

---

## Phase 1: Schema — add `label` to Tags

### Task 1: Add `label` column

**Files:**
- Modify: [db/schema.cds:167](../../../db/schema.cds#L167)

- [ ] **Step 1.1: Add the column** — in `db/schema.cds`, between `name` and `titlePath`, insert `label : String(255);`.
- [ ] **Step 1.2: Verify CDS compiles** — `npx cds compile srv/admin-service.cds -o /dev/null 2>&1 | tail -5`.
- [ ] **Step 1.3: Commit** — `git branch --show-current && git add db/schema.cds && git commit -m "feat(tags): add label column to Tags entity"` (per [[feedback_verify_branch_before_commit]], refuse if branch is `main`).

### Task 2: Surface `label` in admin Tags Fiori Elements app

**Files:**
- Modify: [app/admin-annotations.cds:612-644](../../../app/admin-annotations.cds#L612-L644)

- [ ] **Step 2.1: Add label annotation + LineItem** — add `label @Common.Label: 'Display Label';` to the Tags annotation block. Rename `name` label from "Name" to "Internal Name" to disambiguate. Add `{ Value: label }` to `@UI.LineItem` after `name`.
- [ ] **Step 2.2: Make Tags updatable** — change `Capabilities.UpdateRestrictions.Updatable: false` to `true`. Leave Insertable/Deletable false (still managed by the import flow).
- [ ] **Step 2.3: Commit**.

### Task 3: Verify projection picks up label

**Files:** [srv/admin-service.cds:38](../../../srv/admin-service.cds#L38)

- [ ] **Step 3.1:** the projection is `entity Tags as projection on ims.Tags { *, ... }`. Wildcard covers the new column — no source change needed.
- [ ] **Step 3.2: Verify CDS compile**.
- [ ] **Step 3.3:** No commit needed.

### Task 4: Deploy schema to DEV HANA

- [ ] **Step 4.1: Confirm cf target** — `cf target` shows `tutorial-system / dev`.
- [ ] **Step 4.2: Confirm scope with Tom** — per [[feedback_confirm_deploy_scope]], ask whether this is a schema-only deploy or rolled in with later phases.
- [ ] **Step 4.3: Build and deploy** — `npm run cds:build` then `cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f` (per [[project_local_deploy_process]] and [[feedback_hugo_before_mbt]]).
- [ ] **Step 4.4: Verify column in HANA** — hana-cli MCP `hana_query_simple`: `SELECT TOP 5 NAME, LABEL, TITLEPATH FROM COM_SAP_DEVELOPERS_IMS_TAGS`. Expected: 5 rows, LABEL is NULL.

---

## Phase 2: Seed the registry from AEM

### Task 5: Investigate the legacy filter source

- [ ] **Step 5.1: Confirm the source URL** — use the playwright MCP to navigate to `https://developers.sap.com/tutorial-navigator.html`, snapshot the Software Product dropdown, identify the slug field on each option.
- [ ] **Step 5.2: Identify a JSON endpoint, if any** — probe likely AEM JCR paths with `curl`. Document the working endpoint and its response shape in the next task PR description.

### Task 6: Failing test for `parseAemTagPayload`

**Files:** [scripts/__tests__/seed-tag-labels.test.ts](../../../scripts/__tests__/seed-tag-labels.test.ts)

- [ ] **Step 6.1: Write the test** — assert `parseAemTagPayload` extracts `(titlePath, label)` pairs from the AEM payload, decodes HTML entities, and returns `[]` on malformed input.
- [ ] **Step 6.2: Run, verify it fails** — `npx vitest run scripts/__tests__/seed-tag-labels.test.ts`.

### Task 7: Implement `seed-tag-labels.ts`

**Files:** [scripts/seed-tag-labels.ts](../../../scripts/seed-tag-labels.ts)

- [ ] **Step 7.1: Implement the parser and harvester** — fetch AEM HTML/JSON, parse pairs via `parseAemTagPayload`, read existing rows from `/admin/Tags` (`titlePath` + `label`), PATCH each row whose label is null or differs, write unmatched titlePaths to `.tutorial-cache/aem-tags-unmatched.json`. Auth: read bearer token from `ADMIN_BEARER_TOKEN` env. Document mint command in script header (`cf oauth-token`-derived).
- [ ] **Step 7.2: Run the test, verify it passes**.
- [ ] **Step 7.3: Add npm script** — `"seed-tag-labels": "ts-node --esm scripts/seed-tag-labels.ts"`.
- [ ] **Step 7.4: Dry-run against DEV** — set `ADMIN_BEARER_TOKEN` from `cf oauth-token` and `CAP_BASE_URL` to the DEV srv, run `npm run seed-tag-labels`. Expected: `updated N, skipped 0, unmatched M` with N+M ~= 208.
- [ ] **Step 7.5: Verify in HANA** — `SELECT TOP 10 TITLEPATH, LABEL FROM COM_SAP_DEVELOPERS_IMS_TAGS WHERE LABEL IS NOT NULL`.
- [ ] **Step 7.6: Commit**.

---

## Phase 3: Expose the registry to the build

### Task 8: `/build/tag-labels` endpoint

- [ ] **Step 8.1: Locate existing /build registration** — `grep -rn "'/build/navigator'|build/catalog" srv/`.
- [ ] **Step 8.2: Failing endpoint test** — extend `test/build-endpoints.test.js` (create if missing). Assert `GET /build/tag-labels` returns a flat `{ titlePath: label }` map for tags whose label is non-null, with a `Cache-Control: public` header.
- [ ] **Step 8.3: Run, verify fail**.
- [ ] **Step 8.4: Implement the helper** — create `srv/lib/tag-label-map.js` with `getTagLabelMap()` reading `Tags` (titlePath, label) where label is non-null; returns a flat object.
- [ ] **Step 8.5: Register the endpoint** — `app.get('/build/tag-labels', ...)` with `Cache-Control: public, max-age=300`.
- [ ] **Step 8.6: Run test, verify pass**.
- [ ] **Step 8.7: srv-qa cp-list audit** — per [[feedback_srv_qa_cp_list_recurring]] and [[feedback_srv_qa_cp_list]], re-walk transitive imports from `srv/lib/content-store.js`, confirm `.deploy/mta.yaml` srv-qa cp list includes `srv/lib/tag-label-map.js`. Add if missing.
- [ ] **Step 8.8: Commit**.

### Task 9: Enrich `/content/nav` with labels

**Files:** [srv/lib/content-store.js:1004-1051](../../../srv/lib/content-store.js#L1004-L1051)

- [ ] **Step 9.1: Failing test** — extend `test/lib/content-store.test.js` near line 311. Assert `displayTagSlugs` is emitted, and `displayTags` uses `Tag.label` when set, falls back to `humanizeFallback` of `titlePath` when null.
- [ ] **Step 9.2: Run, verify fail**.
- [ ] **Step 9.3: Implement** — pull `titlePath`, `label`, `name` columns; emit `displayTagSlugs` (slug array) and `displayTags` (label-or-fallback array). Add a `humanizeFallback` helper at the top of `content-store.js` mirroring the build-side heuristic.
- [ ] **Step 9.4: Run, verify pass**.
- [ ] **Step 9.5: Commit**.

---

## Phase 4: Build-time changes

### Task 10: Extend `humanizeTag` for registry lookup

- [ ] **Step 10.1: Failing test** — `humanizeTag('software-product>sap-s-4hana', { 'software-product>sap-s-4hana': 'SAP S/4HANA' })` returns `'SAP S/4HANA'`. With empty registry: returns the heuristic output. No registry param: preserves today behavior (back-compat).
- [ ] **Step 10.2: Run, verify fail**.
- [ ] **Step 10.3: Implement** — add optional `registry?: Record<string, string>` param, look up first, fall back.
- [ ] **Step 10.4: Run, verify pass**.
- [ ] **Step 10.5: Commit**.

### Task 11: Wire registry through fetch-tutorials and emit displayTagSlugs

- [ ] **Step 11.1: Add `displayTagSlugs` to `scripts/parsers/types.ts`**.
- [ ] **Step 11.2: Failing test** in `test/parsers/render-frontmatter.test.ts` — pass a registry, assert dual emission of `displayTags` and `displayTagSlugs`.
- [ ] **Step 11.3: Run, verify fail**.
- [ ] **Step 11.4: Implement** — accept optional `registry` param in `renderFrontmatter` and `writeHugoTutorial`. Map tag arrays through `humanizeTag(s, registry)` for `displayTags`, pass through raw for `displayTagSlugs`. In `fetch-tutorials.ts`, fetch registry from `${CAP_BASE_URL}/build/tag-labels` once at the top of the pipeline; on failure, log a warn and pass `{}` so the heuristic fallback still runs.
- [ ] **Step 11.5: Run, verify pass**.
- [ ] **Step 11.6: End-to-end build smoke** — point `CAP_BASE_URL` at DEV srv, run `npm run fetch-tutorials`, grep for `displayTags:` and `displayTagSlugs:` in a generated `.md` — expect `SAP S/4HANA` and `software-product>sap-s-4hana`.
- [ ] **Step 11.7: Commit**.

---

## Phase 5: Frontend (navigator + search + license)

### Task 12: Carry `displayTagSlugs` through types

- [ ] **Step 12.1: Add field** to `TutorialEntry` and `CardItem` in `hugo-apps/src/shared/types.ts`.
- [ ] **Step 12.2: Run typecheck** — `npx vue-tsc --noEmit -p hugo-apps/tsconfig.json`. Expected failures in `useSearch.ts`, `TutorialNavigator.vue`, `license.ts`.
- [ ] **Step 12.3: No commit yet** — typecheck failures get fixed in next tasks.

### Task 13: License detection by slug

- [ ] **Step 13.1: Failing test** — `requiresLicense({ displayTags, displayTagSlugs })` returns true iff `displayTagSlugs` includes `'tutorial>license'`. `visibleTags(item)` returns labels minus the one whose slug is the license slug.
- [ ] **Step 13.2: Run, verify fail**.
- [ ] **Step 13.3: Implement** — refactor `license.ts` to take an item-shaped argument; export `LICENSE_SLUG`.
- [ ] **Step 13.4: Run, verify pass**.
- [ ] **Step 13.5: Update caller** — `TutorialNavigator.vue:736` becomes `<LicenseIcon v-if="requiresLicense(item)" />`.
- [ ] **Step 13.6: Audit all callers** — per [[feedback_audit_all_callers_of_buggy_primitive]], grep for `requiresLicense\\|LICENSE_TAG` across the whole repo and update.
- [ ] **Step 13.7: Commit**.

### Task 14: Navigator filter — keys on slug, renders label

- [ ] **Step 14.1: Rekey `PRODUCT_TO_TOPICS`** — replace every key in the table at `TutorialNavigator.vue:96-270` with the corresponding raw slug from `Tags.titlePath`. Pull the canonical mapping with hana-cli MCP and translate mechanically.
- [ ] **Step 14.2: Update `availableProducts`** — emit `{ slug, label }` pairs deduped by slug, sorted by label.
- [ ] **Step 14.3: Update `filteredProducts` and template** — search filters on label; checkboxes key on slug; `<span class="filter-label">{{ product.label }}</span>`.
- [ ] **Step 14.4: Update filter equality** — at `TutorialNavigator.vue:450`, change `item.displayTags.some(t => filters.products.includes(t))` to `item.displayTagSlugs.some(s => filters.products.includes(s))`. Same for `tutorialMatchesTopic` and `availableTopics`.
- [ ] **Step 14.5: Re-run typecheck and tests** — `npx vue-tsc --noEmit -p hugo-apps/tsconfig.json` + `npx vitest run hugo-apps/`.
- [ ] **Step 14.6: Commit**.

### Task 15: Enrich search-result `mapToCardItem` with slugs

- [ ] **Step 15.1: Update mapping** in `useSearch.ts:23` to populate `displayTagSlugs` from `enriched?.displayTagSlugs` with primaryTag fallback.
- [ ] **Step 15.2: Update test fixtures** in `useSearch.test.ts` and `cardProgress.test.ts` to include `displayTagSlugs`.
- [ ] **Step 15.3: Run tests**.
- [ ] **Step 15.4: Commit**.

---

## Phase 6: Validate end-to-end

### Task 16: Local hybrid validation

- [ ] **Step 16.1: Run hybrid CAP** — `npm run dev:hybrid` (per [[project_local_hybrid_dev]]). Wait for both srv and approuter ready.
- [ ] **Step 16.2: Verify endpoint** — `curl -s http://localhost:4004/build/tag-labels | jq '."software-product>sap-s-4hana"'`. Expect `"SAP S/4HANA"`.
- [ ] **Step 16.3: Rebuild Hugo with the registry** — `rm -rf .tutorial-cache hugo/content/tutorials hugo/static/tutorials/_nav.json`; `CAP_BASE_URL="http://localhost:4004" npm run fetch-tutorials`; `npm run build:all`. Per [[feedback_hugo_before_mbt]], do not parallelize.
- [ ] **Step 16.4: Visual check** — open `http://localhost:5000/tutorial-navigator/`. Software Product filter shows `SAP S/4HANA Cloud Public Edition` with slash + proper case. Tick the box; cards filter correctly. Click a card; tag chip on Object Page renders the same label. Toggle License filter; license-icon still appears on license-gated tutorials.
- [ ] **Step 16.5: Take screenshot** for PR description (playwright MCP `browser_take_screenshot`).

### Task 17: Unit + hybrid + smoke test sweep

- [ ] **Step 17.1: Full unit run** — `npm test`. Expected: green vs baseline (620 passing / 0 failing / 13 skipped).
- [ ] **Step 17.2: Hybrid run** — `npm run test:hybrid`.
- [ ] **Step 17.3: Defer smoke** until DEV deploy lands.

### Task 18: Update docs

- [ ] **Step 18.1: CLAUDE.md addition** — Gotchas: note slug/label split, the `/build/tag-labels` endpoint, and that labels are admin-edited at `/admin-ui/#tags-display`.
- [ ] **Step 18.2: center-admin.md addition** — sub-section on the `Display Label` column.
- [ ] **Step 18.3: Commit**.

### Task 19: Open the PR

- [ ] **Step 19.1: Push branch** — `git push -u origin feature/tag-label-registry`.
- [ ] **Step 19.2: Open PR via gh** — per [[feedback_pr_over_direct_merge]]:

```bash
gh pr create --title "fix(navigator): restore proper tag labels (slug to label registry)" \
             --body-file docs/superpowers/plans/2026-06-01-tag-label-registry.md \
             --base main
```

- [ ] **Step 19.3: Update memory** — save `project_tag_label_registry.md` once merged + deployed, per [[graphify]] conventions.

---

## Risk register

| Risk | Mitigation |
|---|---|
| AEM scrape returns fewer slugs than HANA has -> some tags stay un-labeled | Unmapped queue dumped to `.tutorial-cache/aem-tags-unmatched.json` for review. Fallback heuristic still produces something, just the lossy version. |
| AEM endpoint URL/format changes between writing this plan and running | Step 5 (Investigate) is mandatory — do not assume. |
| `srv-qa` cp list miss crashes QA boot | Step 8.7 explicitly audits per [[feedback_srv_qa_cp_list_recurring]]. |
| Existing TutorialTags rows are empty so `/content/nav` does not change behavior in practice | Acceptable — the build-time path (`fetch-tutorials` -> `_nav.json`) is the live read path. The DB path is wired correctly so when TutorialTags gets populated, it will work. |
| CRLF flip on Windows during multi-section edits | Per [[feedback_crlf_regression_on_windows]], run `file hugo-apps/src/navigator/TutorialNavigator.vue` after multi-edit; normalize via Node before commit if needed. |
| Schema deploy + frontend land in same PR -> field missing in QA | Phase 1 deploys schema first, dry-run seeder, then build/frontend land. Two-phase rollout. |
| Branch flip mid-session per [[feedback_verify_branch_before_commit]] | Every commit step prefixes `git branch --show-current && ...`; refuse if branch is `main`. |
