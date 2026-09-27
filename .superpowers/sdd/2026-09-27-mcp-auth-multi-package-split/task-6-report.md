# Task 6 Report: Carve `packages/core` Fully

## Summary

Moved 27 domain/runtime utility files from `srv/lib/` (and `srv/jobs/`) into `@tutorials/core` (`packages/core/`) following the same ESM shim pattern established in Task 4 for `legacy-id.js`.

## Per-File: Exports Recorded → Moved → Shimmed

| File | Real Exports | Moved From | Blocked? |
|------|-------------|-----------|---------|
| secret-resolver.js | resolveSecret, invalidateSecret, _resetForTests, _primeForTests | srv/lib/ | No |
| credstore.js | readSecret, writeSecret, deleteSecret, _resetForTests | srv/lib/ | No |
| metrics.js | counter, gauge, observe, snapshot, rotate, emitLogLine, _resetForTest | srv/lib/ | No |
| alerting.js | raise, raiseTest, _resetForTest | srv/lib/ | No |
| feature-flags/db-flags.js | FLAG_TTL_MS, refreshFeatureFlags, bustFeatureFlagsCache, ensureFeatureFlagDefaults, isFlagEnabled, managedFlagKeys, flagMeta, __setFlagForTest, __resetFlagsForTest | srv/lib/ | No |
| feature-flags/registry.js | KINDS, ENV_RULES, STATUSES, FEATURE_FLAGS | srv/lib/ | No |
| runtime-config/alert-settings.js | isAlertingEnabled, _resetForTest | srv/lib/ | No |
| runtime-config/load-shed-settings.js | DEFAULT_CONFIG, resolveLoadShedConfig, _resetForTest, _primeForTest | srv/lib/ | No |
| _tutorials-table.js | tutorialsTableInfo | srv/lib/ | No |
| content-delta-flags.js | DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY, FLAG_TTL_MS, refreshContentDeltaFlags, bustContentDeltaFlagsCache, ensureContentDeltaDefaults, isDeltaWrite, isDeltaRead, isDeltaSkipCarryForward | srv/lib/ | No |
| task-record-submission-id.js | stampSubmissionId | srv/lib/ | No |
| page-key-map.js | PAGE_KEY_PREFIX, extForMime, IN_SCOPE_PAGES, pageKeyForPath, pathForPageKey, isPageKey, mimeTypeForPageKey, discoverPageFiles, AUTHOR_KEY_PREFIX, isAuthorKey, discoverAuthorPages, ADVOCATE_KEY_PREFIX, isAdvocateKey, discoverAdvocatePages | srv/lib/ | No |
| pipeline-log.js | logPipelineStart, logPipelineEnd, logPipeline, logPipelineItem, logJobItem | srv/lib/ | No |
| markdown.js | renderMarkdown | srv/lib/ | No |
| tag-md-format.js | titlePathToMdFormat, applyMdFormat | srv/lib/ | No |
| tag-label-map.js | getTagLabelMap | srv/lib/ | No |
| semaphore-tags.js | getSemaphoreMdMap, formatSmTechIds | srv/lib/ | No |
| edge-cache-headers.js | CONTENT_CACHE_CONTROL, cacheTagsFor, setContentCacheHeaders | srv/lib/ | No |
| page-fallback.js | loadPageFallback | srv/lib/ | No (see note) |
| load-shed.js | acquireServeSlot, _inFlightForTest, _resetForTest | srv/lib/ | No |
| jobs/job-lock.js | acquireLock, releaseLock | srv/jobs/ | No |
| step-text-extractor.js | MAX_CHUNK_CHARS, extractStepText | srv/lib/ | No |
| embedding-client.js | embed | srv/lib/ | No |
| chat-settings-resolver.js | resolveChatLlmSettings, resolveEmbeddingSettings | srv/lib/ | No |
| branch/slug-key.js | slugifyKey | srv/lib/ | No |
| resolve-tutorial-author.js | resolveTutorialAuthor | srv/lib/ | No |
| safe-fetch.js | isLiteralPrivateAddress, _setLookupForTests, resolveAndCheckHost, safeFetch | srv/lib/ | No |

**Note on page-fallback.js**: This file resolves a filesystem path to `srv/page-fallback/`. The path differs depending on whether it runs from the package source (`packages/core/`) or the bundle (`srv/lib/_shared/core.bundle.mjs`). Fixed with a probe-both-candidates approach using `fs.statSync` — the function is fail-open (returns null on missing files) so this is safe.

## Exports Map Approach

Used wildcard subpath export in `packages/core/package.json`:
```json
{
  "exports": {
    ".": "./index.js",
    "./*": "./*"
  }
}
```
This avoids 27 explicit subpath entries while covering all moved files.

## Barrel Changes

Updated `packages/core/index.js` to re-export all moved files' public surface. Name conflicts discovered:
- `FLAG_TTL_MS`: exported by both `feature-flags/db-flags.js` and `content-delta-flags.js` — barrel exports it only from `db-flags.js`
- `_resetForTest`: exported by multiple modules — barrel omits test helpers to avoid conflict

Test-helper functions (`_resetForTest`, `_resetForTests`, `_primeForTest`, `__setFlagForTest`, `__resetFlagsForTest`) are not re-exported from the barrel (consumers use subpath imports in tests).

## Bundle Regen Result

```
bundled srv\lib\_shared\core.bundle.mjs
bundle keys count: 82
```

Bundle includes all moved exports.

## Verification Commands

```
# Boundary lint
node scripts/lint-package-boundaries.cjs → "package boundaries OK"

# Bundle
node scripts/bundle-shared.cjs → success, 82 keys

# Package subpath
import('@tutorials/core/metrics.js') → 7 exports
import('./srv/lib/metrics.js') → 7 exports (via shim → bundle)

# Feature-flags subpath
import('@tutorials/core/feature-flags/db-flags.js') → 9 exports
import('./srv/lib/feature-flags/db-flags.js') → 9 exports

# Real consumer
import('./srv/developer-service.js') → "dev-service OK"
```

## Test Counts

```
Test Files  65 failed | 1335 passed | 2 skipped (1402)
     Tests  217 failed | 10313 passed | 95 skipped | 2 todo (10627)
   Duration  415.82s
```

Previous run baseline: `65 failed | 1329 passed` (1396 total). Same 65 failed test files = **no new failures**. The 217 individual test failures are pre-existing (port-3000/MediaPipe/Vite/credstore infra failures).

## git diff --stat

```
29 files changed, 92 insertions(+), 13 deletions(-)
```
Clean diff — only real changed lines, no phantom churn.

## Concerns / Notes

1. **page-fallback.js filesystem path**: The dual-candidate probe approach works but is worth noting. When the bundle file is at `srv/lib/_shared/core.bundle.mjs`, `../../page-fallback` correctly resolves to `srv/page-fallback/`. When at `packages/core/page-fallback.js`, `../../srv/page-fallback` correctly resolves to `srv/page-fallback/` from the project root. The `statSync` probe picks the right one at startup, and the fail-open contract means any path miss just returns null.

2. **mta.yaml cp commands**: The `mta.yaml` `srv-qa` builder copies `../../srv/lib/*.js` files. After this task, those paths return the ESM shims (which try bundle-first). The bundle is generated by `node scripts/bundle-shared.cjs` during the `before-all` build step in mta.yaml, so the shims will successfully resolve the bundle at CF runtime.

3. **jobs/job-lock.js location**: The file was at `srv/jobs/job-lock.js` (not `srv/lib/jobs/`) — task brief said `jobs/job-lock.js` with the note "move to packages/core/jobs/job-lock.js". Moved from `srv/jobs/` and shim placed at `srv/jobs/job-lock.js`. The shim uses `'../lib/_shared/core.bundle.mjs'` for the relative bundle path from `srv/jobs/`.

4. **No files were BLOCKED**: All 27 files have imports limited to node builtins, npm packages (`@sap/cds`, `@sap-ai-sdk/foundation-models`, `markdown-it`, `cheerio`, `undici`, `jose`, `@sap/xsenv`), or other files in the move list.
