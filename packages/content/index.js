// Barrel re-exports for @tutorials/content.
// This file is the esbuild entry point for the CF deploy bundle
// (scripts/bundle-shared.cjs -> srv/lib/_shared/content.bundle.mjs).
// Consumers use subpath imports (e.g. '@tutorials/content/content-store.js');
// the barrel ensures the bundle entry captures every module.
//
// Names that conflict across files are only re-exported from the canonical module.
// Test helpers (_resetForTest etc.) are not included in the barrel — use subpath imports.

// content-store.js
export { createContentHandlers, toBuffer, isCatalogSlug, dropCatalogSlugs, recomputeTutorialProgress, triggerPostPublishEmbeddings, DEFAULT_CONTENT_CACHE_TTL_MS, ContentCache, invalidateRenderCache, invalidateContentCache, contentAuthMiddleware, publishHandler, serveHandler, markdownServeHandler, hashesHandler, sourceHashesHandler, excludedSlugsHandler, getTutorialSource, navHandler, rollbackHandler, orphanPurgeHandler, beginHandler, appendHandler, commitHandler, abortHandler, pipelineLogFailureHandler, quarantineIngestHandler, pageServeHandler, authorServeHandler, advocateServeHandler } from './content-store.js';
// content-publish-session.js
export { createSessionHelpers, classifyTouchedTutorials } from './content-publish-session.js';
// catalog-data.js
export { loadGroupContext, loadMissionContext, resolveSmTechIds } from './catalog-data.js';
// catalog-renderer.js
export { synthCatalogDescription, renderGroupBody, renderMissionBody, renderCatalogPage } from './catalog-renderer.js';
// catalog-mission-hierarchy.js
export { assembleMissionHierarchy, collectAltGroups } from './catalog-mission-hierarchy.js';
// chrome-shell.js
export { createShellLoader, ShellMarkerError, composeShell, parseShell, canonicalUrlFor, buildBreadcrumbJsonLd } from './chrome-shell.js';
// content-cache-coherence.js
export { onCacheGenerationChange, refreshCacheGeneration, bumpCacheGeneration, GEN_KEY, CHECK_TTL_MS } from './content-cache-coherence.js';
// embedding-pipeline.js
export { embedSlugs } from './embedding-pipeline.js';
// fast-purge.js
export { purgePublishedSlugs, purgeAllContent, purgeTags } from './fast-purge.js';
// recompute-tutorial-progress-bulk-sql.js
export { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
// provenance-data.js
export { loadProvenanceInputs } from './provenance-data.js';
// provenance-freshness.js
export { deriveConfidence, FRESH_MAX_AGE_DAYS, STALE_AGE_DAYS } from './provenance-freshness.js';
// category-classifier.js
export { classifyAndPersist, HIGH_THRESHOLD, AMBIGUITY_GAP, MAX_CATEGORIES } from './category-classifier.js';
// category-classifier-llm.js
export { classifyViaLlm } from './category-classifier-llm.js';
// category-seed-embeddings.js
export { getSeedEmbeddings, embedAdHoc, invalidateSeedEmbedding } from './category-seed-embeddings.js';
// attachment-source-handler.js (warmAttachments + extractAttachmentUrls are in attachment-warm-utils)
export { attachmentSourceHandler, warmAttachmentsLive } from './attachment-source-handler.js';
// image-source-handler.js (warmImages is in image-warm-utils; extractImgCdnUrls re-exported from image-warm-utils)
export { imageSourceHandler, warmImagesLive, extractImgCdnUrls } from './image-source-handler.js';
// image-warm-utils.js
export { channelFor, warmImages } from './image-warm-utils.js';
// attachment-warm-utils.js
export { resolveAttachmentSourceUrl, extractAttachmentUrls, warmAttachments } from './attachment-warm-utils.js';
