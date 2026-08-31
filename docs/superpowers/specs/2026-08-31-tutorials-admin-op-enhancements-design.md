# Tutorials Admin Object Page — Enhancements Design

**Date:** 2026-08-31
**Status:** Draft for review
**Scope:** `AdminService.Tutorials` Object Page (Fiori Elements) + supporting CDS model, fetch/publish pipeline, and object-store exposure.

## Motivation

The Tutorials admin Object Page has three facets that render **empty tables** despite being wired correctly end-to-end, plus a large body of persisted data that is never surfaced. Investigation (four research passes) found a single recurring root cause for the empties: **the admin UI is correctly wired, but the fetch/publish pipeline never populates the backing entity with data it already holds.** This design closes those gaps and adds high-value read-only facets from data we already persist.

Example tutorial used for reference: `Tutorials(ID=1350bd47-09eb-5656-a9b9-bdc2575441cb)` on `developers.sap.com/admin-ui/`.

## Decisions locked (from brainstorming)

1. **Categories** — one-time backfill **plus** self-healing at publish time.
2. **Validation rules** — **persist** the full parsed `rules.vr` rule set at publish time into a new read-only entity (not on-demand GitHub parse).
3. **Contributors** — populate the **full git-derived contributor list** (up to 10: login, name, email, avatar), each linking to `github.com/<login>`.
4. **Media** — surface object-store items with **rich detail** (explicit user ask).

## Resolved decisions (approved 2026-08-31)

- **D1 — Object Store prod binding gap.** `package.json` sets `attachments.kind: s3` for `[production]`, but **`mta.yaml` declares no `objectstore` resource and `tutorials-srv` binds none**. **Resolved:** ship the Media facet (works regardless of backing store); the S3 binding is a **separate ops task**, out of scope here.
- **D2 — Byte size / image dimensions.** **Resolved:** add `byteSize : Integer64` and persist `buffer.length` at ingest now; **defer** width/height (needs `probe-image-size` wiring).
- **D3 — WS3 validation UI.** **Resolved:** keep BOTH facets — relabel the existing AI-only facet "AI-Graded Validation", add the new "All Validation Rules" facet alongside it.

## Workstreams

Five independently shippable workstreams. Suggested phasing at the end.

---

### WS1 — Categories: populate + self-heal

**Problem:** The Categories facet reads `TutorialCategories` (AI-classifier-derived junction, cosine ≥ 0.32 / LLM tiebreak). Publish/migration create `Tutorials` rows via **direct `INSERT.into(Tutorials)`** (`srv/lib/content-publish-session.js:748-762`), bypassing the CAP `after('CREATE','Tutorials')` classifier hook (`srv/handlers/categories-after-hooks.js:44-53`). So classification never fires for published tutorials.

**Design:**
1. **Backfill (one-time):** confirm category seed embeddings exist (admin `embedAllSeeds`), then run `scripts/backfill-categories.cjs` against the target DB.
2. **Self-heal (pipeline):** after `upsertTutorialMetadata`/`linkTutorialAuthorship` in `content-publish-session.js` (~`:198-210`), iterate the already-collected touched `tutorialIds` and call the exported `classifyAndPersist('tutorial', id).catch(warn)` **fire-and-forget** — mirroring the swallow-and-warn dispatcher in `categories-after-hooks.js:34-40`. Never throw into the publish tx.

**No schema change.** `TutorialCategories`, its projection (`srv/admin-service.cds:174`), `@UI.LineItem`, and the facet already exist.

**Risk:** classification is LLM-backed on the tiebreak path; publishing many slugs could fan out calls. Mitigate by keeping it fire-and-forget and reusing the existing threshold/short-circuit (most slugs resolve on cosine alone; skips write nothing).

**Testing:** unit — publish a tutorial through the session, assert `classifyAndPersist` invoked with the new `tutorial_ID`; hybrid — publish + assert `TutorialCategories` rows exist for the slug.

---

### WS2 — Contributors: map git list + GitHub links

**Problem:** `TutorialContributors` is fully wired (entity `db/schema.cds:451-457`, projection `srv/admin-service.cds:234`, `@UI.LineItem` + facet `app/admin-annotations.cds:715-725,767`) but never populated per-tutorial: IMS migration inserts rows with `tutorial_ID = NULL` (`scripts/migrate-from-hana.js:360`); publish only SELECTs/UPDATEs (`linkTutorialAuthorship`), never INSERTs. The rich git contributor list (`{login, name, email, avatarUrl}`) exists in scope at fetch time (`scripts/fetch-tutorials.ts` ~`:936-948`) and flows to Hugo frontmatter (`render-frontmatter.ts:119`) but never into CAP.

**Design:**
1. **Schema:** extend `TutorialContributors` with `login : String(255)`, `avatarUrl : String(1024)`, `profileUrl : String(1024)` (derive `profileUrl = https://github.com/<login>`). Keep existing `name`, `email`, `role`, `user`. Add via `cds build --production` migration (never hand-author `.hdbmigrationtable`); register the entity in `db/persistence.cds` if a fresh table/columns need journaling.
2. **Sidecar (fetch):** beside the validate-answer write (`fetch-tutorials.ts:1043`), write `<slug>.contributors.json` = `{ slug, contributors: contributors.slice(0,10).map(...) }` using the in-scope array (same `writeFileSync(join(CACHE_DIR, ...))` idiom).
3. **Publish aux step:** mirror `publishValidateAnswerSpecs` — a new client collector in `publish-content.ts` globs `*.contributors.json` and POSTs `{ slug, contributors }` per slug (non-fatal aux step).
4. **Server upsert:** new `srv/lib/contributors-publish.js` following the **REPLACE-per-slug inside `cds.tx()`** pattern from `validate-answer-spec-publish.js`: resolve tutorial by lowercased slug → `DELETE.from(TutorialContributors).where({tutorial_ID})` → `INSERT` the new set. Apply the `entity_not_in_model` fail-fast guard and skip on `channel === 'qa'` if the QA namespace lacks the entity.
5. **UI:** add `login` (as GitHub link via `@Communication.Contact` or a `@UI.LineItem` cell with `@Common.SemanticObject`/URL), `avatarUrl`, and keep name/email/role. Render the avatar + external link to `github.com/<login>`, mirroring the live page (`tutorial-author.html`).

**srv-qa cp-list:** add `srv/lib/contributors-publish.js` to the `cp` command in `.deploy/mta.yaml` (module `tutorials-srv-qa`, ~`:175`).

**Testing:** unit — server upsert replaces rows for a slug, leaves other slugs untouched; parser — sidecar shape; hybrid — publish + assert contributor rows with `login`/`avatarUrl` link to the tutorial.

---

### WS3 — Validation: surface ALL rules.vr rules

**Problem:** The Validation Questions facet is bound to `ValidateAnswerSpecs`, which by design persists **only AI-graded** questions (`collectAiGradedSpecs` drops non-AI at `scripts/parsers/rules.ts:320`; `correctAnswer` is server-only for AI grading). `rules.vr` *is* fully fetched and parsed for every tutorial, but the plain client-graded MCQ/exact-match rules are never persisted.

**Design:**
1. **New entity** `TutorialValidationRules` (read-only in admin), key `(tutorial, stepNumber, questionId)`, fields: `questionText`, `ruleType`, `questionType` (MCQ/TEXT), `choiceMode` (single/multiple), `options` (LargeString JSON or child rows), `correctAnswer`, `aiGrading : Boolean`. Register in `db/persistence.cds`.
   - *Note:* MCQ correct answers for client-graded rules are already public (they ship in Hugo frontmatter `TutorialStep.validation`), so showing them in the admin is not a new leak. AI-graded reference answers remain in `ValidateAnswerSpecs` as today.
2. **Sidecar (fetch):** write `<slug>.validation-rules.json` = `{ slug, rules: [...] }` from the **full** `validationMap` (available at `fetch-tutorials.ts:975`), not the AI-filtered subset. Carry `type`, `options`, `choiceMode`, `correctAnswers` in addition to the AI-spec fields.
3. **Publish + server upsert:** same REPLACE-per-slug pattern (new `srv/lib/validation-rules-publish.js`; add to srv-qa cp-list).
4. **UI:** new facet "All Validation Rules" (read-only `@UI.LineItem`) with columns: step, question, type, ruleType, grading (AI/client), correct answer. **Keep both facets** (D3): relabel the existing AI facet "AI-Graded Validation"; the new all-rules facet sits alongside it.

**Testing:** parser — sidecar carries all rule types incl. non-AI; server upsert REPLACE semantics; hybrid — publish a tutorial with mixed AI + MCQ rules, assert both appear in `TutorialValidationRules` and only AI ones in `ValidateAnswerSpecs`.

---

### WS4 — Knowledge-Graph facet

**Problem:** The richest hidden dataset. `TutorialConceptLinks` (teaches/extends + confidence, `db/knowledge-graph.cds:61-70`), `TutorialRank` (PageRank, `:196-200`), `KgCommunity`/`KgCommunityLabel`, and `CoCompletions` ("users who did A also did B") are **not exposed on AdminService** (they live on `KnowledgeGraphService`).

**Design (read-only, additive):**
1. Expose on `AdminService` as `@readonly` projections + associations from `Tutorials`:
   - `conceptLinks` (teaches/prerequisites with confidence) — association already injected on the db entity (`db/knowledge-graph.cds:94-97`).
   - `TutorialRank` — surface score as a virtual/flattened field or a small FieldGroup.
   - Community label — via `KgCommunity`/`KgCommunityLabel` (KgCommunityMembers already exposed `srv/admin-service.cds:1249`).
   - Co-completed neighbors — new read-only projection on `CoCompletions`.
   - Use `@cds.redirection.target: false` on pick-list-style projections to avoid stealing redirects (pattern at `srv/admin-service.cds:114,120`).
2. **UI:** a "Knowledge Graph" facet: LineItem of concepts taught (concept, predicate, confidence), a prerequisites list, PageRank + community label in a FieldGroup, and a co-completed-tutorials LineItem.

**No pipeline change** — these are populated by existing nightly jobs. **Fail-open reads** (mirror existing KG decorators that leave fields unset on SELECT throw).

**Testing:** unit — projections resolve and are `@readonly`; hybrid — a tutorial with concept links shows them.

---

### WS5 — Media facet + Freshness report header

**Problem:** `TutorialImages` (`db/tutorial-images.cds`) and `TutorialAssets` (`db/tutorial-assets.cds`) are **not exposed on any service**. `FreshnessReport` is exposed (`srv/admin-service.cds:129`) but the OP only facets findings, not the report header.

**Design — Media:**
1. **Expose** `@readonly` projections of `TutorialImages` and `TutorialAssets` on `AdminService`, reachable from `Tutorials` (association on matching `slug`, `channel='prod'`). The `content : Composition of many Attachments` child auto-exposes with `@cap-js/attachments` annotations (`@Core.MediaType`, `@Core.ContentDisposition`, `@UI.MediaResource`) → native Fiori **download/preview link**.
2. **Surfaceable detail (persisted today):** `sourceUrl` (GitHub raw URL, render as external link), `contentHash` (sha-256), `mimeType`, `channel`, child `filename` + `createdAt` + `status`. 
3. **Byte size (D2):** add `byteSize : Integer64` to the schema and persist `buffer.length` at ingest (`srv/lib/image-ingest-handler.js` ~`:77`); width/height deferred.
4. **UI:** "Media" facet with two tables (Images, Assets): thumbnail/download link, filename, mime, size (if added), source URL link, content hash, channel.

**Design — Freshness header:**
- Add a "Freshness Report" FieldGroup on the OP sourcing the latest `FreshnessReport` for the tutorial: `runAt`, `model`, `cost`, `status` (QUEUED/RUNNING/DONE/FAILED), `openHighCount`, `error`. Sits above the existing findings facet.

**Testing:** unit — projections `@readonly`, media child annotations present; hybrid — a tutorial with ingested images shows rows + a working download link; freshness header reflects the latest report row.

---

## Cross-cutting constraints

- **srv-qa cp-list:** every new `srv/lib/*.js` (contributors-publish, validation-rules-publish) and any new dep MUST be appended to the `cp` command in `.deploy/mta.yaml` (`tutorials-srv-qa`, ~`:175`), or QA boot fails with `MODULE_NOT_FOUND`.
- **Schema/migration:** WS2 + WS3 (+ optional WS5 byteSize) add columns/entities → `cds build --production`, register in `db/persistence.cds` (`@cds.persistence.journal`), never hand-author `.hdbmigrationtable`. Run `npx cds deploy --to sqlite::memory:` before committing db changes.
- **BLOB reads:** any raw content read stays `db.run()` (never mix LOB + metadata in one CDS QL query).
- **QA namespace:** new publish routes need the `entity_not_in_model` guard + skip on `channel === 'qa'` if the QA CDS model lacks the entity.
- **Feature-flag registry:** if any new `*Settings` Boolean column is introduced, register it (guard requirement); none currently planned.
- **PR flow:** feature branch → PR targeting **DEV** (never main).

## Suggested phasing

- **Phase 1 (fixes your 3 empties):** WS1 (categories), WS2 (contributors), WS3 (validation). Highest user-visible payoff; shares the sidecar/publish pattern.
- **Phase 2 (new visibility):** WS5 (media + freshness header) — you flagged media as the most exciting.
- **Phase 3:** WS4 (KG facet) — additive, read-only, lowest risk but largest surface.

Each workstream is independently shippable; phases can overlap. TDD throughout (unit + hybrid guards per workstream).

## Out of scope (this design)

- The S3/object-store prod binding investigation (D1) — separate ops task.
- Learner submission pass-rate analytics, learning-path membership facet, audit-field surfacing — noted in the inventory as future candidates, not included here to keep scope focused.
