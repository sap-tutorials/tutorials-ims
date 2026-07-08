# Community Blog Posts (issue #1033) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the homepage "Community Blogs" column to "Community Blog Posts", pull candidates from an admin-editable list of SAP Community RSS feeds, run each through an AI relevance classifier, persist verdicts with admin override, and always show ≥3 posts by padding from raw candidates when the approved pool is short.

**Architecture:** Two new CDS entities (`CommunityBlogSources`, `CommunityBlogPosts`), two backend modules (`community-blogs-fetcher.js`, `community-blogs-classifier.js`), two cron jobs (fetch 30 min, classify 15 min), rewritten `HomepageService.communityBlogs()` handler reading from DB with a ≥3 floor, admin UI at `/admin-ui/#community-blog-posts`, English-only for v1.

**Tech Stack:** CAP Node.js 10, HANA Cloud, `@sap-ai-sdk/orchestration` (forced tool-call), Fiori Elements V4, Vue 3, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-1033-community-blog-posts-design.md`

## Global Constraints

- **English-only for v1.** Non-English posts are dropped at fetch time via RSS `<language>` element with ASCII-heuristic fallback.
- **No `@Common.ValueList` anywhere on `CommunityBlogPosts` or `CommunityBlogSources`.** Guards against the `@cap-js/ai` AICore-kind-resolution crash on draft Creates (per memory `cap-ai-plugin-aicore-kind-resolution`).
- **≥3 floor on the visitor endpoint.** Pad from raw candidates when approved pool is short. `adminOverride='BLOCK'` wins even in padded mode.
- **All AI calls via `@sap-ai-sdk/orchestration` + `resolveChatLlmSettings()`** — same pattern as `srv/lib/category-classifier-llm.js`. Never `cds.connect.to('AICore')` — that's the `@cap-js/ai` plugin path.
- **Cron minutes off-cycle:** fetch at `:17`, classify at `:07`. Never on `:00` or `:30` (per memory rule).
- **`cds deploy --to sqlite::memory:` before committing** any change to `db/**/*.cds` or `db/data/*.csv` (per memory).
- **CSV wipes editable columns on deploy** — Sources CSV must only include fields safe to overwrite; admin-added rows are safe because they get UUIDs the CSV doesn't touch.
- **`srv-qa` cp-list audit** — any new file under `srv/lib/` or `srv/jobs/` must land in `.deploy/mta.yaml`'s `srv-qa` `cp` list.
- **Never write raw SQL** — use `cds.ql` / CQL. Read-then-UPDATE-or-INSERT for upserts.
- **Vue island payload contract unchanged** — `[{ title, url, publishedAt, author }]`. Only column heading text changes.

---

## Task 1: Add CDS entities + seed CSV + auto-init

**Files:**
- Create: `db/community-blogs.cds`
- Create: `db/data/com.sap.developers.ims-CommunityBlogSources.csv`
- Modify: `srv/admin-service.cds` — add projections
- Modify: `srv/admin-service.js` — add `before('READ')` auto-init handler for Sources
- Test: `test/unit/community-blogs-cds-assert.test.js`

**Interfaces:**
- Produces: entities `com.sap.developers.ims.CommunityBlogSources` and `com.sap.developers.ims.CommunityBlogPosts` (schemas per spec § Data model). Admin projections at `AdminService.CommunityBlogSources` and `AdminService.CommunityBlogPosts`.
- Produces: 3 seed Sources rows on first admin-service read of an empty table.

- [ ] **Step 1: Write the CDS file** — `db/community-blogs.cds`, entity definitions exactly per spec § Data model (both entities including `attemptCount : Integer default 0` on Posts).

- [ ] **Step 2: Write the seed CSV** — `db/data/com.sap.developers.ims-CommunityBlogSources.csv`. Header + 3 rows:

```csv
ID;label;feedUrl;topicSlug;isActive;sortOrder;managed
00000000-0000-0000-0000-000000c81001;Community — Technology (all blogs);https://community.sap.com/khhcw49343/rss/Community?interaction.style=blog;community-technology;true;10;true
00000000-0000-0000-0000-000000c81002;Technology Blogs by SAP;https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap;technology-sap;true;20;true
00000000-0000-0000-0000-000000c81003;Technology Blogs by Members;https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-members;technology-members;true;30;true
```

- [ ] **Step 3: Extend `srv/admin-service.cds`** — add draft-enabled projections for both entities (mirror `HomepageShelves` projection style already present).

- [ ] **Step 4: Add auto-init handler in `srv/admin-service.js`** — `before('READ', 'CommunityBlogSources')` inserts the same 3 seed rows if the table is empty. Match the shape of the existing `HomepageConfig` auto-init.

- [ ] **Step 5: Write assert test** — `test/unit/community-blogs-cds-assert.test.js`. Uses `cds.test('serve', ...)`. Verifies `@assert.unique.sourceUrl` on Posts (duplicate INSERT throws), `@assert.unique.label` and `@assert.unique.feedUrl` on Sources.

- [ ] **Step 6: Run `npx cds deploy --to sqlite::memory:`** — confirms schema deploys cleanly and CSV seed loads.

Expected: no errors, `com_sap_developers_ims_CommunityBlogSources` table has 3 rows.

- [ ] **Step 7: Run the assert test** — `npx vitest run test/unit/community-blogs-cds-assert.test.js`.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add db/community-blogs.cds db/data/com.sap.developers.ims-CommunityBlogSources.csv \
        srv/admin-service.cds srv/admin-service.js \
        test/unit/community-blogs-cds-assert.test.js
git commit -m "feat(#1033): CDS entities + seed for Community Blog Posts

Adds CommunityBlogSources (admin-editable RSS feed list) and
CommunityBlogPosts (fetched candidates + AI verdict + admin override).
Includes @assert.unique guards, seed CSV for 3 technology-board feeds,
and before('READ') auto-init on Sources.

Ref #1033"
```

---

## Task 2: Extract `parseRss()` shared helper + browser-UA fetch

**Files:**
- Create: `srv/lib/rss-parse.js` — pure XML-string → items[] helper (extracted from `homepage-rss-fetcher.js`)
- Modify: `srv/lib/homepage-rss-fetcher.js` — imports and delegates to the shared helper; adds `BROWSER_UA` header via `safeFetch`
- Test: `test/unit/rss-parse.test.js`
- Test: `test/unit/homepage-rss-fetcher.test.js` (extend or create for the UA change)

**Interfaces:**
- Produces: `export function parseRss(xml: string): Array<{title, link, publishedAt, description, language}>` — same shape as today plus a new `language` field extracted from `<language>` at item or channel level.
- Produces: `BROWSER_UA` constant (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`).
- Consumes: `safeFetch` from `srv/lib/safe-fetch.js`.

- [ ] **Step 1: Write the failing test** — `test/unit/rss-parse.test.js` with cases: valid RSS with 2 items, item missing title (drops), CDATA-wrapped title (unwraps), item with `<language>de</language>` (language field set to `de`), channel-level `<language>en-us</language>` inherits when item has none, unparseable pubDate (publishedAt null + warn), whitespace-only description (null).

- [ ] **Step 2: Run test to verify FAIL** — `npx vitest run test/unit/rss-parse.test.js`.

Expected: FAIL — `srv/lib/rss-parse.js` doesn't exist.

- [ ] **Step 3: Create `srv/lib/rss-parse.js`** — port `parseRss()` from `homepage-rss-fetcher.js` verbatim, then add `<language>` extraction (item-level, fallback to channel-level). Export `parseRss` and `BROWSER_UA`.

- [ ] **Step 4: Run test to verify PASS** — same command.

Expected: PASS.

- [ ] **Step 5: Refactor `srv/lib/homepage-rss-fetcher.js`** — replace inline `parseRss` with `import { parseRss, BROWSER_UA } from './rss-parse.js'`. Add `headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' }` to the `safeFetch` call.

- [ ] **Step 6: Run existing homepage RSS tests to confirm no regression** — `npx vitest run test/unit/homepage-rss-fetcher.test.js` (or all `homepage-service-*` tests if that file doesn't exist yet).

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/rss-parse.js srv/lib/homepage-rss-fetcher.js \
        test/unit/rss-parse.test.js
git commit -m "refactor(#1033): extract parseRss + send browser UA

Extracts parseRss() from homepage-rss-fetcher.js into a shared
srv/lib/rss-parse.js. Adds <language> extraction (item-level +
channel-level fallback) needed for the English-only filter in
Task 3. The community-blogs fetcher and the existing
communityBlogs()/news() RSS paths now both send a browser-shaped
User-Agent — the current one fixes the Cloudflare 403 that has
been silently emptying the Community lane.

Ref #1033"
```

---

## Task 3: `community-blogs-fetcher.js` module + unit test

**Files:**
- Create: `srv/lib/community-blogs-fetcher.js`
- Test: `test/unit/community-blogs-fetcher.test.js`

**Interfaces:**
- Produces: `export async function fetchAllSources({ log }): Promise<{fetched, upserted, skippedLang, errored}>` — reads active Sources via `cds.tx`, iterates.
- Produces: `export async function fetchOneSource(source, { log }): Promise<{fetched, upserted, skippedLang, errored}>` — per-source; best-effort try/catch around each item.
- Consumes: `parseRss`, `BROWSER_UA` from `srv/lib/rss-parse.js`; `safeFetch` from `srv/lib/safe-fetch.js`.

- [ ] **Step 1: Write the failing test** — `test/unit/community-blogs-fetcher.test.js`. Uses `cds.test('serve', ...)`. Mocks `safeFetch` with canned XML. Cases: (a) 2 English items upserted; (b) `<language>de</language>` item skipped (skippedLang counter increments); (c) missing title dropped; (d) re-fetch same URL refreshes `lastSeenAt` and updates mutable fields but preserves `aiVerdict`; (e) fetch throws → source's `errored` incremented, other sources continue; (f) new rows land as `aiVerdict='PENDING'` with `attemptCount=0`.

- [ ] **Step 2: Run test to verify FAIL** — module doesn't exist.

- [ ] **Step 3: Implement `srv/lib/community-blogs-fetcher.js`** — logic per spec § Fetcher. English-language check: `language` field starts with `en` OR (language missing AND title heuristic passes: ≥3 ASCII words separated by spaces AND ≤10% non-ASCII chars). SELECT-then-UPDATE-or-INSERT upsert on `sourceUrl`. Per-item try/catch. Per-source try/catch. Emits metrics via `srv/lib/metrics.js`. Never touches `aiVerdict` on updates.

- [ ] **Step 4: Run test to verify PASS**.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/community-blogs-fetcher.js test/unit/community-blogs-fetcher.test.js
git commit -m "feat(#1033): community-blogs-fetcher module

Pulls active CommunityBlogSources, fetches each RSS feed with the
browser UA header, drops non-English items via <language>+ASCII
heuristic, upserts CommunityBlogPosts on sourceUrl, and refreshes
lastSeenAt on re-sightings while preserving classifier state.

Ref #1033"
```

---

## Task 4: `community-blogs-classifier.js` module + unit test

**Files:**
- Create: `srv/lib/prompts/community-blogs-classifier.md` — system prompt
- Create: `srv/lib/community-blogs-classifier.js`
- Test: `test/unit/community-blogs-classifier.test.js`

**Interfaces:**
- Produces: `export async function classifyPendingBatch({ log, limit }): Promise<{drained, ok, parseError, aicoreError, disabled?}>`.
- Produces: `export async function classifyOne(row, { orchestrationClient, log }): Promise<{aiVerdict, aiReason, aiConfidence, aiClassifiedAt, aiModel, attemptCount}>` — pure computation, returns row-update fields; caller writes back.
- Consumes: `OrchestrationClient` from `@sap-ai-sdk/orchestration`, `resolveChatLlmSettings` from `srv/lib/chat-settings-resolver.js`.

- [ ] **Step 1: Write the prompt file** — `srv/lib/prompts/community-blogs-classifier.md` with system prompt content per spec § Classifier. Adjusted for forced tool-call: the last paragraph says "You MUST call the submit_verdict tool with your answer" instead of "reply with JSON".

- [ ] **Step 2: Write the failing test** — `test/unit/community-blogs-classifier.test.js`. Mocks `OrchestrationClient` prototype's `chatCompletion` method. Cases per spec § Testing.

- [ ] **Step 3: Run test to verify FAIL**.

- [ ] **Step 4: Implement `srv/lib/community-blogs-classifier.js`** — forced tool-call `submit_verdict` with JSON-schema-encoded output (verdict enum, confidence number, reason string). Loads prompt file at module init (cached). Sequential drain, batch limit from `process.env.COMMUNITY_BLOGS_CLASSIFY_BATCH ?? 10`. Try/finally around the loop. Kill switch check at top of `classifyPendingBatch`. Retry-once via `attemptCount<2` filter. Emits `homepage.community_blogs.classifier[result=...]` metrics.

- [ ] **Step 5: Run test to verify PASS**.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/prompts/community-blogs-classifier.md \
        srv/lib/community-blogs-classifier.js \
        test/unit/community-blogs-classifier.test.js
git commit -m "feat(#1033): community-blogs-classifier module

Drains PENDING CommunityBlogPosts via SAP Generative AI Hub with
forced tool-call for structured output. Attempt-bounded retry
(attemptCount<2) means transient AI errors self-heal; persistent
failures land as sticky ERROR until an admin runs Reclassify.
Honours COMMUNITY_BLOGS_CLASSIFIER_ENABLED kill switch.

Ref #1033"
```

---

## Task 5: Cron job wiring

**Files:**
- Create: `srv/jobs/community-blogs-fetch-job.js`
- Create: `srv/jobs/community-blogs-classify-job.js`
- Modify: `srv/jobs/scheduler.js` — import + registerJob for both
- Test: `test/unit/community-blogs-jobs-registration.test.js`

**Interfaces:**
- Produces: `runCommunityBlogsFetch(logId)` and `runCommunityBlogsClassify(logId)` exports.
- Produces: JOB_REGISTRY entries `community-blogs-fetch` (schedule `17 */30 * * *` → every 30 min at :17) and `community-blogs-classify` (schedule `7 */15 * * *` → every 15 min at :07).

- [ ] **Step 1: Write both job files** — thin wrappers that call `fetchAllSources` / `classifyPendingBatch` inside a `cds.tx` and return the summary object.

- [ ] **Step 2: Wire into `srv/jobs/scheduler.js`** — imports at top of file, `registerJob({ ... })` blocks inside `registerJobs()` matching existing style. Set `ttlMs` conservatively (fetch: 300000 = 5 min; classify: 60000 = 1 min — batch is ~3 s).

- [ ] **Step 3: Write registration test** — `test/unit/community-blogs-jobs-registration.test.js`. Imports `registerJobs` + `_getJobRegistry`, resets registry, calls registerJobs(), asserts both new entries exist with expected schedule strings.

- [ ] **Step 4: Run test** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/community-blogs-fetch-job.js \
        srv/jobs/community-blogs-classify-job.js \
        srv/jobs/scheduler.js \
        test/unit/community-blogs-jobs-registration.test.js
git commit -m "feat(#1033): register community-blogs cron jobs

Two scheduled jobs — fetch every 30 min at :17, classify every 15
min at :07. Both go through the standard runWithLock chassis so
their outcomes show up on /admin-ui/#job-controls.

Ref #1033"
```

---

## Task 6: Rewrite `HomepageService.communityBlogs()` + cache invalidation

**Files:**
- Modify: `srv/homepage-service.js` — rewrite the `communityBlogs()` handler, add cache slot + `resetCommunityBlogsCache()` export
- Modify: `srv/admin-service.js` — call `resetCommunityBlogsCache()` in after-UPDATE hooks on `CommunityBlogPosts` and `CommunityBlogSources`
- Test: `test/unit/homepage-service-endpoints.test.js` (extend)

**Interfaces:**
- Produces: rewritten `communityBlogs()` returning `[{title, url, publishedAt, author}]` (same shape as today).
- Produces: `export function resetCommunityBlogsCache(): void` in `homepage-service.js`.
- Consumes: `CommunityBlogPosts` entity from `cds.entities('com.sap.developers.ims')`.

- [ ] **Step 1: Write the failing tests** — extend `test/unit/homepage-service-endpoints.test.js` with cases per spec § Testing (pinned-first, ALLOW/BLOCK/null, degraded pad, empty DB).

- [ ] **Step 2: Run to verify FAIL**.

- [ ] **Step 3: Rewrite the handler** — Query A + optional Query B algorithm per spec § Public endpoint. 60 s in-process cache in the existing `_state` object. Metric emission on served/degraded/error paths.

- [ ] **Step 4: Add `resetCommunityBlogsCache()` export and wire into admin-service.js after-UPDATE hooks** for both entities.

- [ ] **Step 5: Run tests to verify PASS**.

- [ ] **Step 6: Commit**

```bash
git add srv/homepage-service.js srv/admin-service.js \
        test/unit/homepage-service-endpoints.test.js
git commit -m "feat(#1033): rewrite communityBlogs() to read DB

Handler now reads CommunityBlogPosts with the pinned-first /
adminOverride / aiVerdict selection. Pads from raw candidates when
approved pool <3 (BLOCK still wins). 60 s in-process cache with
resetCommunityBlogsCache() invalidation from admin-service on any
update.

Ref #1033"
```

---

## Task 7: Admin annotations + Reclassify action

**Files:**
- Modify: `app/admin-annotations.cds` — LineItem + FieldGroup + SelectionFields for both entities
- Modify: `srv/admin-service.cds` — add `reclassifyCommunityBlogPost` action
- Modify: `srv/admin-service.js` — action handler
- Test: `test/unit/admin-service-reclassify.test.js`

**Interfaces:**
- Produces: `AdminService.reclassifyCommunityBlogPost(ID: UUID) returns Boolean`. SuperAdmin-scoped. Resets `aiVerdict='PENDING'`, `aiClassifiedAt=null`, `aiReason=null`, `attemptCount=0`.

- [ ] **Step 1: Write UI annotations** — LineItem columns per spec § Admin UI, SelectionFields for Posts filters, default filter for `aiVerdict IN (PENDING, ERROR)`.

- [ ] **Step 2: Add action to CDS + handler** — SuperAdmin scope enforcement matches other admin actions.

- [ ] **Step 3: Write action test** — happy path + auth denial.

- [ ] **Step 4: Run tests PASS**.

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds srv/admin-service.cds \
        srv/admin-service.js test/unit/admin-service-reclassify.test.js
git commit -m "feat(#1033): admin UI + Reclassify action

FE V4 List Report annotations for CommunityBlogSources + Posts.
Default filter on Posts surfaces PENDING/ERROR rows first.
Reclassify action on the OP resets a row for the classifier drain.

Ref #1033"
```

---

## Task 8: Admin shell tile wiring

**Files:**
- Modify: `app/admin-shell/webapp/manifest.json` — add `community-blog-posts` route + tile
- Modify: `app/admin-shell/webapp/view/App.view.xml` — add nav entry (if the shell uses declarative nav)
- Create: `app/community-blog-posts/webapp/manifest.json` (minimal FE app scaffold pointing at both entities)
- Create: `app/community-blog-posts/webapp/Component.js`, `index.html`, etc. — mirror the smallest existing admin sub-app (e.g. `app/homepage/`)

**Interfaces:**
- Produces: `/admin-ui/#community-blog-posts` route that loads both LRs.

- [ ] **Step 1: Copy the closest existing admin sub-app** — probably `app/homepage/` — into `app/community-blog-posts/`.

- [ ] **Step 2: Rewrite `manifest.json`** — service URI `/api/admin/`, primary entity `CommunityBlogPosts`, secondary/embedded `CommunityBlogSources`.

- [ ] **Step 3: Register in admin-shell** — add tile in `app/admin-shell/webapp/manifest.json`.

- [ ] **Step 4: Run `npm run build:apps` (or the smallest relevant script)** to verify no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add app/community-blog-posts/ app/admin-shell/
git commit -m "feat(#1033): admin shell tile for Community Blog Posts

New route at /admin-ui/#community-blog-posts loads the Sources +
Posts LRs. Follows the same shell-embed pattern as the existing
/admin-ui/#homepage tile.

Ref #1033"
```

---

## Task 9: Vue island + Hugo partial rename

**Files:**
- Modify: `hugo-apps/src/homepage-bands/CommunityLane.vue` — heading text "Community Blogs" → "Community Blog Posts"; aria-label same
- Modify: `hugo/layouts/partials/homepage/community-lane.html` — aria-label "Community blogs" → "Community blog posts"

**Interfaces:** None (UI copy only).

- [ ] **Step 1: Edit heading + aria-label** in both files.

- [ ] **Step 2: Rebuild hugo-apps** — `npm run build:apps` (or the specific hugo-apps build). Confirm no errors.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/homepage-bands/CommunityLane.vue \
        hugo/layouts/partials/homepage/community-lane.html
git commit -m "feat(#1033): rename UI copy to Community Blog Posts

Ref #1033"
```

---

## Task 10: MTA `srv-qa` cp-list audit + docs

**Files:**
- Modify: `.deploy/mta.yaml` — add new `srv/lib/*.js`, `srv/jobs/*.js`, `srv/lib/prompts/*.md`, and `app/community-blog-posts/**` to relevant `cp` lists
- Modify: `docs/developers/architecture/homepage.md` — Row 6 rename, extend failure-modes table, new sub-section
- Create: `docs/developers/reference/community-blog-posts.md` — full reference doc

- [ ] **Step 1: Walk transitive imports** — from `srv/homepage-service.js` and `srv/admin-service.js` through the new files. List every file that must be in `srv-qa`'s `cp` block.

- [ ] **Step 2: Add cp entries to `.deploy/mta.yaml`**.

- [ ] **Step 3: Write reference doc** at `docs/developers/reference/community-blog-posts.md` covering: entities, admin workflow, cron cadences, env vars, prompt file location, CSV-wipe gotcha reminder, how to un-stick ERROR.

- [ ] **Step 4: Update `docs/developers/architecture/homepage.md`** — Row 6 rename, extend failure-modes table.

- [ ] **Step 5: Commit**

```bash
git add .deploy/mta.yaml docs/developers/architecture/homepage.md \
        docs/developers/reference/community-blog-posts.md
git commit -m "docs(#1033): mta cp-list + reference doc + Row 6 rename

Ref #1033"
```

---

## Task 11: Full test run + open PR

- [ ] **Step 1: Run all unit tests** — `npm test`. All PASS.

- [ ] **Step 2: Push branch** — `git push -u origin worktree-1033-community-blog-posts`.

- [ ] **Step 3: Open draft PR** — `gh pr create --draft --title "feat(#1033): Community Blog Posts — rename, AI classifier, admin override, ≥3 floor" --body "$(cat body.md)"`. Body references the spec + plan and summarises the change.

## Self-review

- **Spec coverage** — every spec section maps to a task above.
- **Type consistency** — `attemptCount` used consistently; entity names match; endpoint payload shape unchanged.
- **Placeholder scan** — none.
