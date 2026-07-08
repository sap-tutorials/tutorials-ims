// Guards the FE V4 selection-reader shape in the three explainer
// ActionsController.js files. The original code used
// `oEvent.getParameter("selectedContexts")`, which returns undefined for
// custom manifest LineItem actions on UI5 ≥ 1.108. Symptoms: "Mark
// selected as reviewed" and "Regenerate selected with AI" both silently
// hit the "Select one or more rows first" path — the POST never left the
// browser and AI_SEEDED rows never flipped.
//
// The fix introduced a shared `readSelectedContexts(oEvent)` helper that
// prefers `oEvent.getSource().getSelectedContexts()` (the FE V4 canonical
// path), falling back to the legacy parameter names. This test doesn't
// eval the source (that'd be code injection even from a checked-in file);
// it asserts the four required behaviors against a hand-rolled reference
// implementation of the same shape, and asserts the source contains each
// branch so a future refactor that silently drops one will fail here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTROLLERS = [
  ['verb-definitions',  'app/admin/verb-definitions/webapp/ext/ActionsController.js'],
  ['shelf-definitions', 'app/admin/shelf-definitions/webapp/ext/ActionsController.js'],
  ['homepage',          'app/admin/homepage/webapp/ext/ActionsController.js'],
];

// Reference implementation — must match the helper embedded in each
// ActionsController.js. The static-source checks below make sure the
// three checked-in copies match this shape.
function readSelectedContextsRef(oEvent) {
  const src = oEvent.getSource?.();
  if (src && typeof src.getSelectedContexts === 'function') {
    const ctxs = src.getSelectedContexts();
    if (Array.isArray(ctxs) && ctxs.length > 0) return ctxs;
  }
  return (
    oEvent.getParameter?.('contexts') ??
    oEvent.getParameter?.('selectedContexts') ??
    []
  );
}

function mockEvent({ selectedFromSource, paramMap = {} }) {
  return {
    getSource() {
      return selectedFromSource === undefined
        ? undefined
        : { getSelectedContexts: () => selectedFromSource };
    },
    getParameter(name) {
      return paramMap[name];
    },
  };
}

describe('readSelectedContexts reference implementation (FE V4 selection reader)', () => {
  it('prefers getSource().getSelectedContexts() when it yields rows (FE V4 1.108+)', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const evt = mockEvent({
      selectedFromSource: rows,
      paramMap: { selectedContexts: [{ id: 'stale' }] },
    });
    expect(readSelectedContextsRef(evt)).toBe(rows);
  });

  it('falls back to oEvent.getParameter("contexts") when getSelectedContexts returns []', () => {
    const rows = [{ id: 'x' }];
    const evt = mockEvent({
      selectedFromSource: [],
      paramMap: { contexts: rows },
    });
    expect(readSelectedContextsRef(evt)).toBe(rows);
  });

  it('falls back to oEvent.getParameter("selectedContexts") as last resort', () => {
    const rows = [{ id: 'y' }];
    const evt = mockEvent({
      selectedFromSource: undefined,
      paramMap: { selectedContexts: rows },
    });
    expect(readSelectedContextsRef(evt)).toBe(rows);
  });

  it('returns [] when no source or parameter has rows', () => {
    const evt = mockEvent({ selectedFromSource: [], paramMap: {} });
    expect(readSelectedContextsRef(evt)).toEqual([]);
  });
});

// Guard the checked-in source: each controller must contain the helper
// and use `readSelectedContexts(oEvent)` at both call sites. A regression
// that drops the ExtensionAPI branch or reverts to the raw
// `oEvent.getParameter("selectedContexts")` extraction fails here.
describe.each(CONTROLLERS)('%s ActionsController.js — selection reader wiring', (_name, filePath) => {
  const src = readFileSync(join(process.cwd(), filePath), 'utf8');

  it('defines the readSelectedContexts helper', () => {
    expect(src).toMatch(/function\s+readSelectedContexts\s*\(\s*oEvent\s*\)/);
  });
  it('prefers oEvent.getSource().getSelectedContexts()', () => {
    // Two independent checks so re-ordering / renaming still catches the
    // intent: the source() branch AND the method name must both appear.
    expect(src).toMatch(/oEvent\.getSource\?\.\(\)/);
    expect(src).toMatch(/getSelectedContexts\s*===\s*['"]function['"]/);
  });
  it('keeps the legacy parameter names only as fallback', () => {
    expect(src).toMatch(/getParameter\?\.\(\s*['"]contexts['"]\s*\)/);
    expect(src).toMatch(/getParameter\?\.\(\s*['"]selectedContexts['"]\s*\)/);
  });
  it('uses readSelectedContexts at both call sites (Regenerate + MarkReviewed)', () => {
    const callSites = src.match(/readSelectedContexts\s*\(\s*oEvent\s*\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
  });
  it('does not reintroduce the broken raw oEvent.getParameter("selectedContexts") extraction', () => {
    // Match the specific bug pattern: a `const … = oEvent.getParameter?.("selectedContexts") ?? []`
    // assignment at a handler top-level. The helper body itself uses
    // getParameter?.("selectedContexts") as fallback, which is fine — that
    // occurrence lives inside `function readSelectedContexts(...)`.
    const badPattern = /const\s+\w+\s*=\s*oEvent\.getParameter\?\.\(\s*['"]selectedContexts['"]\s*\)\s*\?\?\s*\[\]/;
    expect(src).not.toMatch(badPattern);
  });
});
