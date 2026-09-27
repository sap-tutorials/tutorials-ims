// Barrel re-exports for @tutorials/core.
// This file is the esbuild entry point for the CF deploy bundle
// (scripts/bundle-shared.cjs -> srv/lib/_shared/core.bundle.mjs).
// All moved core modules are accessible here so the bundle captures them.
// Consumers use subpath imports (e.g. '@tutorials/core/metrics.js') and do
// NOT rely on named re-exports from this barrel. The barrel only ensures
// the bundle entry includes every module.
//
// Names that conflict across files are exported only from the canonical module;
// others use 'export *' for convenience. Test helpers (_resetForTest etc.) are
// not re-exported from the barrel — they are used via subpath imports in tests.

// Previously moved (Task 4)
export { getNextLegacyId, resetCounters } from './legacy-id.js';

// Moved in Task 6 — re-export public surface; skip test-helper duplicates.
// secret-resolver.js
export { resolveSecret, invalidateSecret } from './secret-resolver.js';
// credstore.js
export { readSecret, writeSecret, deleteSecret } from './credstore.js';
// metrics.js (FLAG_TTL_MS conflict: metrics doesn't export it — no conflict here)
export { counter, gauge, observe, snapshot, rotate, emitLogLine } from './metrics.js';
// alerting.js
export { raise, raiseTest } from './alerting.js';
// feature-flags/db-flags.js (exports FLAG_TTL_MS — keep it here)
export { FLAG_TTL_MS, refreshFeatureFlags, bustFeatureFlagsCache, ensureFeatureFlagDefaults, isFlagEnabled, managedFlagKeys, flagMeta } from './feature-flags/db-flags.js';
// feature-flags/registry.js
export { KINDS, ENV_RULES, STATUSES, FEATURE_FLAGS } from './feature-flags/registry.js';
// runtime-config/alert-settings.js
export { isAlertingEnabled } from './runtime-config/alert-settings.js';
// runtime-config/load-shed-settings.js (DEFAULT_CONFIG exported)
export { DEFAULT_CONFIG, resolveLoadShedConfig } from './runtime-config/load-shed-settings.js';
// _tutorials-table.js
export { tutorialsTableInfo } from './_tutorials-table.js';
// content-delta-flags.js (FLAG_TTL_MS conflict: skip FLAG_TTL_MS from here)
export { DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY, refreshContentDeltaFlags, bustContentDeltaFlagsCache, ensureContentDeltaDefaults, isDeltaWrite, isDeltaRead, isDeltaSkipCarryForward } from './content-delta-flags.js';
// task-record-submission-id.js
export { stampSubmissionId } from './task-record-submission-id.js';
// page-key-map.js
export { PAGE_KEY_PREFIX, extForMime, IN_SCOPE_PAGES, pageKeyForPath, pathForPageKey, isPageKey, mimeTypeForPageKey, discoverPageFiles, AUTHOR_KEY_PREFIX, isAuthorKey, discoverAuthorPages, ADVOCATE_KEY_PREFIX, isAdvocateKey, discoverAdvocatePages } from './page-key-map.js';
// pipeline-log.js
export { logPipelineStart, logPipelineEnd, logPipeline, logPipelineItem, logJobItem } from './pipeline-log.js';
// markdown.js
export { renderMarkdown } from './markdown.js';
// tag-md-format.js
export { titlePathToMdFormat, applyMdFormat } from './tag-md-format.js';
// tag-label-map.js
export { getTagLabelMap } from './tag-label-map.js';
// semaphore-tags.js
export { getSemaphoreMdMap, formatSmTechIds } from './semaphore-tags.js';
// edge-cache-headers.js
export { CONTENT_CACHE_CONTROL, cacheTagsFor, setContentCacheHeaders } from './edge-cache-headers.js';
// page-fallback.js
export { loadPageFallback } from './page-fallback.js';
// load-shed.js
export { acquireServeSlot } from './load-shed.js';
// jobs/job-lock.js
export { acquireLock, releaseLock } from './jobs/job-lock.js';
// step-text-extractor.js
export { MAX_CHUNK_CHARS, extractStepText } from './step-text-extractor.js';
// embedding-client.js
export { embed } from './embedding-client.js';
// chat-settings-resolver.js
export { resolveChatLlmSettings, resolveEmbeddingSettings } from './chat-settings-resolver.js';
// branch/slug-key.js
export { slugifyKey } from './branch/slug-key.js';
// resolve-tutorial-author.js
export { resolveTutorialAuthor } from './resolve-tutorial-author.js';
// safe-fetch.js
export { isLiteralPrivateAddress, resolveAndCheckHost, safeFetch } from './safe-fetch.js';
// buffers.js
export { toBuffer } from './buffers.js';
// recompute-tutorial-progress.js
export { recomputeTutorialProgress } from './recompute-tutorial-progress.js';
