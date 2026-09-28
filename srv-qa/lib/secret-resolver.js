// Workspace-first shim: resolves @tutorials/core secret-resolver in local dev;
// falls back to the CF deploy bundle at srv-qa/lib/_shared/core.bundle.mjs.
// Mirrors the pattern in srv/lib/secret-resolver.js.
// srv-qa imports only resolveSecret from secret-resolver.
let mod;
try { mod = await import('@tutorials/core/secret-resolver.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const resolveSecret = mod.resolveSecret;
