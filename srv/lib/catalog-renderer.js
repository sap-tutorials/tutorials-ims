// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/catalog-renderer.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const synthCatalogDescription = mod.synthCatalogDescription;
export const renderGroupBody = mod.renderGroupBody;
export const renderMissionBody = mod.renderMissionBody;
export const renderCatalogPage = mod.renderCatalogPage;
