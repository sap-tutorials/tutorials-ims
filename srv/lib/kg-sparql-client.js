// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-sparql-client.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const SparqlPrivilegeError = mod.SparqlPrivilegeError;
export const SparqlSyntaxError = mod.SparqlSyntaxError;
export const SparqlTimeoutError = mod.SparqlTimeoutError;
export const kgGraphClear = mod.kgGraphClear;
export const kgGraphInsert = mod.kgGraphInsert;
export const kgQuery = mod.kgQuery;
export const kgAdminRunSparql = mod.kgAdminRunSparql;
export const __TESTING__ = mod.__TESTING__;
