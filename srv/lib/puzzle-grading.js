// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/puzzle-grading.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const parseLayout = mod.parseLayout;
export const parseSolution = mod.parseSolution;
export const buildSlots = mod.buildSlots;
export const wordForSlot = mod.wordForSlot;
export const deriveSlotIds = mod.deriveSlotIds;
export const gradeEntries = mod.gradeEntries;
export const validatePuzzle = mod.validatePuzzle;
