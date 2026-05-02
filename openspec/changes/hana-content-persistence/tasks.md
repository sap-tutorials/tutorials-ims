# Tasks: HANA Content Persistence

## Phase 1 — Data Layer & Endpoints

- [x] Add `ContentFiles` and `ContentManifest` entities to `db/schema.cds`
- [x] Create `srv/lib/content-store.js` — publish, serve, rollback logic
- [x] Register `/content/publish` endpoint in `srv/server.js` (Bearer token auth)
- [x] Register `/content/:slug` serve endpoint (unauthenticated, gzip streaming)
- [x] Register `/content/nav` dynamic nav endpoint (replaces `_nav.json`)
- [x] Register `/content/rollback` endpoint (Bearer token auth)
- [x] Register `/content/hashes` endpoint (returns slug→hash map for delta detection)
- [x] Add concurrency control (SELECT FOR UPDATE on manifest)
- [x] Add content compression (gzip on write, stream on read)
- [x] Add ETag/Cache-Control headers to serve endpoint
- [x] Write unit tests (SQLite) for publish + serve + rollback + concurrency
- [x] Write hybrid test for BLOB storage with real HANA

## Phase 2 — CI Pipeline

- [x] Create `scripts/publish-content.ts` — reads Hugo output, computes deltas, POSTs to CAP
- [x] Update `.github/workflows/rebuild-content.yml` to use delta publish
- [x] Add `repository_dispatch` payload parsing (extract changed slugs)
- [x] Add full-rebuild fallback mode (manual trigger or nightly schedule)
- [x] Test delta publish end-to-end in DEV environment

## Phase 3 — AppRouter Integration

- [x] Add `/tutorials/*` route to `approuter/xs-app.json` pointing to CAP
- [x] ~~Add feature flag env var (`CONTENT_FROM_DB=true`) for gradual rollout~~ (skipped — DB-only, no static fallback)
- [x] Test tutorial serving through AppRouter → CAP → HANA path
- [x] Verify browser caching behavior (ETag, 304 responses)
- [x] Load test: concurrent reads under realistic traffic

## Phase 4 — Cleanup

- [x] Remove `static/tutorials/` from AppRouter build pipeline in `mta.yaml`
- [x] ~~Remove `rebuildHandler` from `approuter/server.js`~~ (kept — still needed for non-tutorial static assets)
- [x] Add garbage collection job (prune versions older than 7 days, keep last 3)
- [x] Update `CLAUDE.md` to reflect new architecture
- [x] Write smoke tests for content endpoints

## Dependencies

```
Phase 1 ──────────────┐
                      ├──▶ Phase 3 (needs endpoints deployed)
Phase 2 ──────────────┘         │
                                ▼
                          Phase 4 (cleanup after stable)
```

Phase 1 and Phase 2 can proceed in parallel. Phase 3 requires both to be deployed. Phase 4 is post-validation cleanup.
