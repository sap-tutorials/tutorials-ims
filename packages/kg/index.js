// Barrel re-exports for @tutorials/kg.
// This file is the esbuild entry point for the CF deploy bundle
// (scripts/bundle-shared.cjs -> srv/lib/_shared/kg.bundle.mjs).
// All kg modules are accessible here so the bundle captures them.
// Consumers use subpath imports (e.g. '@tutorials/kg/kg-path.js').

// kg/ subdirectory (now flattened to top level)
export * from './_search-fetches.js';
export * from './community-label-llm.js';
export * from './community-label-match.js';
export * from './community-member-hash.js';
export * from './community-members.js';
export * from './concept-embedding-query.js';
export * from './concepts-for-user.js';
export * from './external-content-signal.js';
export * from './joule-tool-community-peers.js';
export * from './joule-tool-describe-community.js';
export * from './joule-tool-expand-concepts.js';
export * from './joule-tool-find-path.js';
export * from './joule-tool-puzzle-hint.js';
export * from './learning-path.js';
export * from './learning-path-graph.js';
export * from './on-demand-cosine-rank.js';
export * from './on-demand-enqueue.js';
export * from './search-kg-handler.js';

// root kg-*.js
export * from './kg-community-coverage.js';
export * from './kg-community-fingerprint.js';
export * from './kg-concept-loader.js';
export * from './kg-cycles.js';
export * from './kg-explore-data.js';
export * from './kg-extract.js';
export * from './kg-graph-rebuild.js';
export * from './kg-merge-on-write.js';
export * from './kg-merge-pair.js';
export * from './kg-meta-formatters.js';
export * from './kg-neighborhood-cache.js';
export * from './kg-neighborhood-full-helpers.js';
export * from './kg-neighborhood-merge.js';
export * from './kg-other-resources-loader.js';
export * from './kg-path-v2-client.js';
export * from './kg-path.js';
export * from './kg-projection.js';
export * from './kg-published-concepts-cache.js';
export * from './kg-queries.js';
export * from './kg-resource-type-config.js';
export * from './kg-similarity.js';
export * from './kg-sparql-client.js';
export * from './kg-stamp-meta-text.js';
export * from './kg-tutorial-teaches-map.js';

// extra files
export * from './search-kg-signal.js';
export * from './discovery-mission-categories.js';
export * from './kg-settings.js';
