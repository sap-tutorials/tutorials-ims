// Workspace-first shim: resolves @tutorials/content handlers in local dev;
// falls back to the CF deploy bundle at srv-qa/lib/_shared/content.bundle.mjs.
// Mirrors the pattern in srv/lib/content-store.js.
// srv-qa imports only createContentHandlers from content-store.
let mod;
try { mod = await import('@tutorials/content/content-store.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const createContentHandlers = mod.createContentHandlers;
