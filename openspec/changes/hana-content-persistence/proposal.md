# Proposal: HANA Content Persistence for Tutorials

## Problem

Tutorial HTML content currently lives only in the AppRouter's ephemeral filesystem (`approuter/static/`). This creates three critical issues:

1. **Durability** — Container crashes, restages, or scaling events lose all content until the next full rebuild
2. **Update speed** — Every content change requires a full 77MB rebuild+upload, even for single-tutorial edits
3. **Concurrency** — Multiple simultaneous tutorial pushes (from different authors) can conflict or produce partial states

## Proposed Solution

Store rendered tutorial HTML in HANA Cloud as compressed BLOBs, versioned with a manifest. Serve content dynamically through a CAP endpoint. Process only changed tutorials (delta updates) using SHA-based cache invalidation that already exists in the fetch pipeline.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage backend | HANA BLOB | No new service, transactional consistency, existing infra |
| Navigation catalog | Dynamic CAP endpoint | Eliminates cross-cutting concurrency conflict of `_nav.json` |
| Concurrency model | SELECT FOR UPDATE | Proven pattern already in `srv/jobs/job-lock.js` |
| Build tool | Keep Hugo (~30s) | Acceptable speed; full skip is a future optimization |
| Compression | gzip BLOBs | ~85% reduction (77MB → ~12MB stored) |
| Serving | AppRouter → CAP `/content/:slug` | Existing route proxy pattern via BTP Destination |

### Architecture

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    CONTENT UPDATE FLOW                        │
  └──────────────────────────────────────────────────────────────┘

  GitHub Push (tutorial repo)
       │
       ▼
  ┌─────────────────┐     ┌─────────────────────────────────┐
  │  GitHub Action   │────▶│  1. Fetch changed tutorial(s)   │
  │  (CI runner)     │     │  2. Render with Hugo (single)   │
  │                  │     │  3. POST delta to CAP endpoint  │
  └─────────────────┘     └─────────────────────────────────┘
                                         │
                                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      CAP BACKEND                             │
  │                                                              │
  │  POST /content/publish                                       │
  │    ├─ Acquire lock (SELECT FOR UPDATE on ContentManifest)    │
  │    ├─ Validate payload (hashes, sizes)                       │
  │    ├─ UPSERT ContentFiles (gzipped BLOBs)                    │
  │    ├─ Increment manifest version                             │
  │    └─ Release lock                                           │
  │                                                              │
  │  GET /content/:slug                                          │
  │    ├─ Read from ContentFiles (latest version)                │
  │    ├─ Decompress + serve with Cache-Control                  │
  │    └─ 304 Not Modified if ETag matches                       │
  │                                                              │
  │  GET /content/nav                                            │
  │    └─ Dynamic nav catalog (replaces _nav.json file)          │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                     HANA CLOUD                               │
  │                                                              │
  │  ContentFiles { slug, version, content(BLOB), hash, size }   │
  │  ContentManifest { version, status, fileCount, changedFiles }│
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                     APPROUTER                                │
  │                                                              │
  │  /tutorials/:slug → proxy to CAP /content/:slug              │
  │  (static/ dir becomes fallback/bootstrap only)               │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Scope

### In scope
- CDS entities for content storage and versioning
- CAP publish endpoint with concurrency control
- CAP serve endpoint with compression + caching
- Dynamic navigation catalog endpoint
- Delta-aware CI pipeline (GitHub Action)
- AppRouter route change to proxy tutorial requests to CAP
- Rollback capability (serve previous manifest version)

### Out of scope (future)
- Skip Hugo entirely (render server-side from markdown)
- CDN layer in front of CAP
- Real-time preview (author sees changes before publish)
- Multi-region content replication

## Non-goals
- Changing the tutorial authoring experience (still markdown in GitHub)
- Modifying the admin UI
- Replacing the existing fetch-tutorials.ts caching logic (it becomes the CI script's cache)

## Risks

| Risk | Mitigation |
|------|-----------|
| HANA BLOB read latency vs filesystem | Cache-Control headers + ETag; AppRouter can cache in memory |
| HANA storage cost for 12MB compressed | Trivial relative to HANA Cloud instance cost |
| CI runner still needs Hugo installed | Hugo is a single binary; already in the workflow |
| AppRouter memory for decompression | Stream through, don't buffer full response |
| Migration from current static approach | Keep static/ as fallback during transition; feature flag |

## Success Criteria
- Single-tutorial update completes in < 60 seconds end-to-end
- Container restage preserves all content (zero downtime)
- Concurrent pushes from 3+ authors serialize correctly (no lost updates)
- Rollback to previous version completes in < 5 seconds
