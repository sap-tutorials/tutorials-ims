// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/joule-tool-puzzle-hint.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const PUZZLE_HINT_TOOL = mod.PUZZLE_HINT_TOOL;
export const puzzleHintHandler = mod.puzzleHintHandler;
