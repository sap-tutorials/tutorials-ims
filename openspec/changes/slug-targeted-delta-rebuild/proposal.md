## Why

A slug-targeted content rebuild (hotfix to one tutorial) takes ~4m41s even though only one tutorial changed. Profiling a real PROD run (`gh run 32783495862`, slug `hxe-database-server`) showed the pipeline does **full-corpus work in three stages regardless of the slug filter**: the server-side publish re-writes all ~11,253 unchanged content BLOBs into a new version (~95s), the fetch stage regenerates all ~1,430 tutorials from cache and runs full-catalog discovery (~56s), and a GitHub-App-token GraphQL failure silently degrades discovery to ~1,400 slower REST calls. The install step (~48s) was already addressed by node_modules caching (PR #2016). The goal is to make a single-tutorial rebuild **O(changed slugs) end-to-end** (~1 minute), which is what operators expect from the "Rebuild this tutorial" button.

## What Changes

- **Server-side publish scoping (Option B).** Replace the full-snapshot-per-version content model with a mutable current table read directly by the serve path, plus an append-only history table for drift-detection and rollback. A publish writes **only changed slugs** instead of carrying forward the whole corpus.
  - **BREAKING** (internal): `carryForwardUnchanged` is deleted; ~20 readers stop filtering on `version = activeVersion`; rollback changes from a metadata-flip to a replay-from-history; three version-keyed caches re-key off a generation token.
- **Generated-content CI cache.** Cache the git-ignored generated Hugo content tree (`hugo/content/tutorials/` ≈ 25 MB) across runs and regenerate **only the changed slug** when the global inputs are unchanged. The cache key hashes the CAP `/build` feeds, parser source, and per-slug source so any nav/catalog/tag change forces a full regen (correctness over speed).
- **Single-slug Hugo render.** Scope the Hugo render to the changed tutorial plus the always-regenerated aggregate pages, relying on the verified fact that per-tutorial pages bake nav from their own frontmatter and client-hydrate the rest.
- **GraphQL discovery fix.** Stop the error-masking in the GraphQL client (throw on GraphQL errors / null data), fix the auth path so discovery uses a token that can resolve the org node (or make discovery repo-oriented), and make any REST fallback loud instead of silent.

## Capabilities

### New Capabilities
- `content-delta-publish`: Server-side content persistence and serving from a mutable current-version table plus append-only history, so publishing writes only changed slugs; includes drift-detection and history-replay rollback.
- `generated-content-cache`: Deterministic caching of the generated Hugo content tree with a correctness-preserving invalidation key, enabling per-slug regeneration.
- `single-slug-render`: Scoped Hugo rendering of one tutorial page plus the always-regenerated aggregate pages.
- `tutorial-discovery`: Resilient GitHub tutorial discovery/metadata fetch — surfaced errors, correct auth for org-level GraphQL, and loud (not silent) REST fallback.

### Modified Capabilities
<!-- None — no existing specs in openspec/specs/. -->

## Impact

- **CAP backend (`srv/`)**: `content-store.js`, `content-publish-session.js`, `chrome-shell.js`, `publish-concepts.js`, `concept-list-page.js`, `tutorial-step-slicer.js`, `embedding-pipeline.js`, `embedding-stats.js`, `admin-service.js`, `developer-service.js`, `freshness-detector.js`; jobs `embedding-reconciliation.js`, `cleanup.js`.
- **Data model (`db/`)**: new `ContentCurrent` + `ContentHistory` aspects in `_content-shape.cds` (shared with QA namespace); `.hdbmigrationtable` artifacts via `cds build --production`; one-time migration seeding `ContentCurrent` from the current ACTIVE version.
- **Build pipeline (`scripts/`)**: `fetch-tutorials.ts`, `scripts/parsers/*` (esp. `github.ts`, `compose.ts`, `render-frontmatter.ts`), new generated-content cache-key + sidecar for `navEntries`.
- **CI (`.github/workflows/rebuild-content.yml`)**: generated-content cache step + key; token routing for the fetch step; `rebuild-content-qa.yml` parity.
- **Constraints**: HANA LOB-locator (BLOB reads stay on raw `db.run()`); QA-channel parity + `srv-qa` `cp`-list audit; no hand-authored `.hdbmigrationtable` ALTERs; PRs target DEV; deploy/rollback per workstream behind flags.
- **Rollback safety**: each workstream is independently shippable and flag-gated; `ContentFiles`/`ContentManifest` retained read-only for one release as a fallback.
