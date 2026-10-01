// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-graph-rebuild.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const DEFAULT_GRAPH_IRI = mod.DEFAULT_GRAPH_IRI;
export const BOOTSTRAP_TRIPLE = mod.BOOTSTRAP_TRIPLE;
export const GRAPH_METADATA_SINGLETON_ID = mod.GRAPH_METADATA_SINGLETON_ID;
export const projectPredicateCounts = mod.projectPredicateCounts;
export const graphRebuild = mod.graphRebuild;
export const __TESTING__ = mod.__TESTING__;
