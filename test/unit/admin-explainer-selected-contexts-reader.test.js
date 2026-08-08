// Guards the FE V4 selection-reader shape in the three explainer
// ActionsController.js files. The original code used
// `oEvent.getParameter("selectedContexts")`, which returns undefined for
// custom manifest LineItem actions on UI5 >= 1.108. Symptoms: "Mark
// selected as reviewed" and "Regenerate selected with AI" both silently
// hit the "Select one or more rows first" path — the POST never left the
// browser and AI_SEEDED rows never flipped.
//
// A first fix (2026-08-07) guarded the arg shapes (undefined / array / event)
// to stop a crash, but STILL returned [] whenever the arg carried no
// selection. That masked the real behavior: verified live against DEV UI5
// 1.136 on 2026-08-08, FE V4 inside the admin-shell componentUsage host
// invokes the `press` handler with `arg === undefined` even when rows ARE
// selected and the requiresSelection-gated button is correctly enabled. So
// the "return [] on falsy arg" path was the bug — it guaranteed the false
// "Select one or more rows first" toast every time in the shell.
//
// The real fix reads the selection off the app's `sap.ui.mdc.Table` via the
// Element registry (keyed on the bound entity path) whenever the arg-borne
// shapes yield nothing. This test asserts the reference behavior against a
// hand-rolled implementation with an injectable table-reader, and asserts the
// checked-in source contains the fallback branch so a future refactor that
// drops it re-opens the bug.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTROLLERS = [
  ['verb-definitions',  'app/admin/verb-definitions/webapp/ext/ActionsController.js',  '/VerbDefinitions'],
  ['shelf-definitions', 'app/admin/shelf-definitions/webapp/ext/ActionsController.js', '/ShelfDefinitions'],
  ['homepage',          'app/admin/homepage/webapp/ext/ActionsController.js',          '/HomepageShelves'],
];

// Reference implementation — must match the helper embedded in each
// ActionsController.js. `selFromTable` stands in for the real
// _selectedFromTable() (which walks the Element registry in the browser);
// here it's injected so the branch order is testable without a DOM.
function readSelectedContextsRef(oEvent, selFromTable = () => []) {
  if (Array.isArray(oEvent) && oEvent.length > 0) return oEvent;
  const src = oEvent && oEvent.getSource ? oEvent.getSource() : null;
  if (src && typeof src.getSelectedContexts === 'function') {
    const ctxs = src.getSelectedContexts();
    if (Array.isArray(ctxs) && ctxs.length > 0) return ctxs;
  }
  const fromParam =
    (oEvent && oEvent.getParameter && oEvent.getParameter('contexts')) ??
    (oEvent && oEvent.getParameter && oEvent.getParameter('selectedContexts'));
  if (Array.isArray(fromParam) && fromParam.length > 0) return fromParam;
  return selFromTable();
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

  it('falls back to oEvent.getParameter("selectedContexts") as last arg-borne resort', () => {
    const rows = [{ id: 'y' }];
    const evt = mockEvent({
      selectedFromSource: undefined,
      paramMap: { selectedContexts: rows },
    });
    expect(readSelectedContextsRef(evt)).toBe(rows);
  });

  it('accepts an array of contexts passed directly (FE V4 LR toolbar in some builds)', () => {
    const rows = [{ id: 'p' }, { id: 'q' }];
    expect(readSelectedContextsRef(rows)).toBe(rows);
  });

  // The core regression: FE V4 in admin-shell passes NO argument. The reader
  // must NOT return [] — it must recover the selection from the table.
  it('recovers selection from the table when the arg is undefined (admin-shell, DEV 1.136)', () => {
    const tableRows = [{ id: 't1' }, { id: 't2' }];
    expect(readSelectedContextsRef(undefined, () => tableRows)).toBe(tableRows);
    expect(readSelectedContextsRef(null, () => tableRows)).toBe(tableRows);
  });

  it('recovers from the table when the event carries an empty selection', () => {
    const tableRows = [{ id: 't3' }];
    const evt = mockEvent({ selectedFromSource: [], paramMap: {} });
    expect(readSelectedContextsRef(evt, () => tableRows)).toBe(tableRows);
  });

  it('does not throw on an undefined arg (the earlier 2026-08-07 crash)', () => {
    expect(() => readSelectedContextsRef(undefined)).not.toThrow();
    expect(() => readSelectedContextsRef(null)).not.toThrow();
  });

  it('returns [] only when neither the arg nor the table has rows', () => {
    const evt = mockEvent({ selectedFromSource: [], paramMap: {} });
    expect(readSelectedContextsRef(evt, () => [])).toEqual([]);
    expect(readSelectedContextsRef(undefined, () => [])).toEqual([]);
  });
});

// Guard the checked-in source: each controller must contain the helper, the
// table fallback, and use `readSelectedContexts(oEvent)` at both call sites.
// A regression that drops the table-fallback branch or reverts to the raw
// `oEvent.getParameter("selectedContexts")` extraction fails here.
describe.each(CONTROLLERS)('%s ActionsController.js — selection reader wiring', (_name, filePath, entityPath) => {
  const src = readFileSync(join(process.cwd(), filePath), 'utf8');

  it('defines the readSelectedContexts helper', () => {
    expect(src).toMatch(/function\s+readSelectedContexts\s*\(\s*oEvent\s*\)/);
  });
  it('defines the _selectedFromTable helper and calls it as the final fallback', () => {
    expect(src).toMatch(/function\s+_selectedFromTable\s*\(\s*\)/);
    expect(src).toMatch(/return\s+_selectedFromTable\(\)/);
  });
  it('depends on sap/ui/core/Element and walks its registry', () => {
    expect(src).toMatch(/["']sap\/ui\/core\/Element["']/);
    expect(src).toMatch(/Element\.registry\.forEach/);
  });
  it('identifies its own List Report table by the bound entity path', () => {
    // The entity path must match the app's OData set so the fallback picks the
    // right mdc.Table. A copy-paste slip (wrong path) selects nothing → the bug.
    const escaped = entityPath.replace(/[/]/g, '\\/');
    expect(src).toMatch(new RegExp(`LR_ENTITY_PATH\\s*=\\s*["']${escaped}["']`));
    expect(src).toMatch(/getPath\(\)\s*===\s*LR_ENTITY_PATH/);
  });
  it('filters to sap.ui.mdc.Table and reads getSelectedContexts()', () => {
    expect(src).toMatch(/isA\(\s*["']sap\.ui\.mdc\.Table["']\s*\)/);
    expect(src).toMatch(/getSelectedContexts\s*===\s*["']function["']/);
  });
  it('still handles the arg-borne shapes (array + event source + params)', () => {
    expect(src).toMatch(/Array\.isArray\(\s*oEvent\s*\)\s*&&\s*oEvent\.length\s*>\s*0/);
    expect(src).toMatch(/oEvent\.getSource/);
    expect(src).toMatch(/getParameter\(\s*["']contexts["']\s*\)/);
    expect(src).toMatch(/getParameter\(\s*["']selectedContexts["']\s*\)/);
  });
  it('uses readSelectedContexts at both call sites (Regenerate + MarkReviewed)', () => {
    const callSites = src.match(/readSelectedContexts\s*\(\s*oEvent\s*\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
  });
  it('does NOT reintroduce the "return [] on falsy arg" short-circuit that caused the bug', () => {
    // The 2026-08-07 fix opened this: `if (!oEvent) return []` guaranteed the
    // false "select rows" toast in admin-shell (arg is always undefined there).
    expect(src).not.toMatch(/if\s*\(\s*!oEvent\s*\)\s*return\s*\[\]/);
  });
});
