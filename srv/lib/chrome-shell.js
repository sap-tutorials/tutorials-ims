// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/chrome-shell.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const ShellMarkerError = mod.ShellMarkerError;
export const parseShell = mod.parseShell;
export const canonicalUrlFor = mod.canonicalUrlFor;
export const buildBreadcrumbJsonLd = mod.buildBreadcrumbJsonLd;
export const composeShell = mod.composeShell;
export const createShellLoader = mod.createShellLoader;
