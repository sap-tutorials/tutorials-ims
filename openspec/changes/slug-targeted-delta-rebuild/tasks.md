## 1. Workstream A — GraphQL discovery unmask + loud fallback (ship first)

- [ ] 1.1 In `scripts/parsers/github.ts` `graphqlRequest` (:229-234), throw on `json.errors?.length` or null/undefined `data`, including GraphQL error `type`/`message` in the thrown error.
- [ ] 1.2 Update callers (discovery :513-549, batch :763-777 / :826-840) so the thrown error is caught by their existing handlers and logged with cause.
- [ ] 1.3 Emit a single ERROR-level log line in `discoverAllTutorials` / `fetchGitHubMetaBatch` when degrading to REST due to a GraphQL auth/permission error (not just `[graphql-warn]`).
- [ ] 1.4 Unit test: a mocked GraphQL error/null-data response raises with the cause and does NOT produce an opaque TypeError.
- [ ] 1.5 Ship to DEV; run a rebuild and capture the real Phase-1/Phase-2 GraphQL error from logs to decide 2.x.

## 2. Workstream B — GraphQL discovery auth fix

- [ ] 2.1 Decide (from 1.5 evidence) between: repo-oriented discovery (drop `organization(login:)`, enumerate via REST `GET /orgs/{org}/repos`, GraphQL only per-`repository()`) vs. route classic PAT to the fetch step vs. grant the App Org:Read. Record the decision in design.md Open Questions.
- [ ] 2.2 Implement the chosen fix in `github.ts` and/or `.github/workflows/rebuild-content.yml` (:303-310 token step, :348 token routing).
- [ ] 2.3 Verify a DEV rebuild completes discovery on the primary path (no per-batch REST fallback) via log assertion.
- [ ] 2.4 Confirm discovered tutorial set + per-slug metadata are equivalent to the REST fallback (no divergence in contributors/createdAt).

## 3. Workstream C — Generated-content cache + scoped render (CI-only, fail-open)

- [ ] 3.1 Add a `navEntries` sidecar: persist per-slug nav entries during compose so cached slugs can contribute to nav + `browse.json` without recomposition (`fetch-tutorials.ts` around :1087/:1285-1329).
- [ ] 3.2 Compute a generated-content cache key hashing: parser/generator source (`scripts/parsers/*`, `fetch-tutorials.ts`, `expand-ai-authored.ts`), `/build/catalog` + `/build/co-completions` + `/build/tag-labels` payloads, and per-slug source (`.md` sha + `rules.vr` ETag).
- [ ] 3.3 Add an `actions/cache` step for `hugo/content/tutorials/` in `rebuild-content.yml` keyed on 3.2; behind a flag; fail-open to full regen on miss.
- [ ] 3.4 When the cache hits with unchanged globals, regenerate only the changed slug's generated `.md`; reconstruct nav/`browse.json` from the sidecar for cached slugs.
- [ ] 3.5 Scope the Hugo render to the changed slug + always-regenerated aggregate pages; ensure `hugo/data/author_index.json` is current for the scoped render.
- [x] 3.6 Guard: a slug-targeted rebuild with the cache produces byte-identical `hugo/public` output for the changed tutorial vs. a full build (diff harness). — `test/unit/content-cache-diff-guard.test.ts` (generator-level byte-identity: determinism + reuse==regen + feed-gate load-bearing; runs on every PR, no network). End-to-end byte-diff remains a documented DEV A/B.
- [ ] 3.7 Verify on DEV: catalog/nav/tag-label change forces full regen; markdown-only edit hits the fast path; aggregates always reflect the change.
- [x] 3.8 Mirror to `rebuild-content-qa.yml`. — content-cache input (default ON) + `Determine content-cache mode` step + split restore(slug-targeted)/save(full+slug) cache steps + `CONTENT_CACHE_FAST_PATH` env.

## 4. Workstream D — Publish scoping (Option B): schema + migration

- [ ] 4.1 Add `ContentCurrent` and `ContentHistory` aspects to `db/_content-shape.cds` (per design.md D1/D2); mirror into the QA namespace (`db-qa/`).
- [ ] 4.2 Run `cds build --production` to generate `.hdbmigrationtable` artifacts for the new tables (no hand-authored ALTERs).
- [ ] 4.3 Write the seed migration: `INSERT INTO ContentCurrent SELECT ... FROM ContentFiles WHERE version = <ACTIVE>` (one row per slug); optional `ContentHistory` backfill from retained versions.
- [ ] 4.4 `npx cds deploy --to sqlite::memory:` sanity + hybrid deploy check before commit.

## 5. Workstream D — Publish scoping: write path

- [ ] 5.1 Rewrite `appendToSession`/`commitSession` (`content-publish-session.js`) to UPSERT changed slugs into `ContentCurrent` and append `ContentHistory` rows; delete `carryForwardUnchanged` (:1192-1303).
- [ ] 5.2 Migrate the legacy single-shot `publishHandler` (`content-store.js:286-795`) and concept render (`publish-concepts.js`) to the delta write path.
- [ ] 5.3 Bump a monotonic generation token inside the commit transaction (source for cache re-keying in 6.x).
- [ ] 5.4 Gate the new write path behind a **write flag** with dual-write to legacy tables for one release.
- [ ] 5.5 Hybrid test: single-slug publish writes exactly one `ContentCurrent` row and appends history; N-slug publish writes N.

## 6. Workstream D — Publish scoping: readers + caches

- [ ] 6.1 Migrate the hot serve path `serveStoredSlug` (`content-store.js:896-930`) to `WHERE slug=?` on `ContentCurrent`, keeping BLOB reads on raw `db.run()` (LOB-locator).
- [ ] 6.2 Migrate special-slug readers (`__404__`, `__nav__`, `__shell__`) and page/author/advocate/concept serve handlers.
- [ ] 6.3 Migrate catalog/listing/hash/source readers (`navHandlerFallback`, `hashesHandler`, `sourceHashesHandler`, `getTutorialSource`).
- [ ] 6.4 Migrate embeddings/jobs active-slug-set reads (`embedding-pipeline.js`, `embedding-stats.js`, `embedding-reconciliation.js`, `cleanup.js:pruneOrphanEmbeddings`, `admin-service.js:seedEmbeddings`) to `SELECT slug FROM ContentCurrent`.
- [ ] 6.5 Re-key the three version-keyed caches (`chrome-shell.js`, `concept-list-page.js`, `tutorial-step-slicer.js`) off the generation token / `sourceVersion`.
- [ ] 6.6 Gate reader cutover behind a **read flag**; keep legacy `ContentFiles` readers as the fallback path.
- [ ] 6.7 Unit tests: all three caches invalidate after a delta publish.

## 7. Workstream D — Publish scoping: rollback + drift + GC

- [ ] 7.1 Rewrite `rollbackHandler` (`content-store.js:1491-1539`) to replay the target version from `ContentHistory` into `ContentCurrent` (re-insert deleted, remove added).
- [ ] 7.2 Point `detectReverts` (`content-publish-session.js:306-387`) at `ContentHistory` for per-slug source-hash history; fast-path compares to `ContentCurrent.sourceHash`.
- [ ] 7.3 Repurpose `cleanupContentVersions` (`cleanup.js:72-97`) to GC `ContentHistory` (+ superseded manifests) instead of `ContentFiles`.
- [ ] 7.4 Hybrid test: publish → rollback → assert byte-identical served content for every slug; revert-of-stale still rejected.

## 8. Cutover, verification, cleanup

- [ ] 8.1 QA-channel parity: re-audit every touched `srv/lib/` file against the `srv-qa` `cp` list in `.deploy/mta.yaml`.
- [ ] 8.2 DEV verification: byte-identical serve before/after cutover; slug rebuild wall-clock measured (target ~1 min); full smoke suite.
- [ ] 8.3 Flip write flag, run migration-seed, flip read flag on DEV; soak; then QA; then PROD.
- [ ] 8.4 Next release: remove `carryForwardUnchanged`, legacy readers, and the read-only `ContentFiles`/`ContentManifest` fallback once soak is clean.
- [ ] 8.5 Update CLAUDE.md gotchas + memory (snapshot→current model, cache invalidation triggers, GraphQL token routing).
