// Unit tests for app/admin/puzzles/webapp/lib/crossword-geometry.js.
//
// The module is a UI5 AMD module (sap.ui.define) — it cannot be ESM-imported
// directly. Load it through a stubbed sap.ui.define + vm sandbox, capturing the
// factory's return value (same pattern as
// test/unit/admin-shell/cron-timeline-helpers.test.js).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GEOM_PATH = path.resolve(
  __dirname,
  '../../app/admin/puzzles/webapp/lib/crossword-geometry.js'
);

let geom;

beforeAll(() => {
  const src = readFileSync(GEOM_PATH, 'utf8');
  let captured;
  const context = {
    sap: { ui: { define(_deps, factory) { captured = factory(); } } },
    Array, Object, Math, Number, String, JSON,
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: GEOM_PATH });
  if (!captured) throw new Error('crossword-geometry.js did not register a factory');
  geom = captured;
});

describe('crossword-geometry (AMD module)', () => {
  it('exports all nine pure functions', () => {
    for (const fn of ['makeEmptyGrid', 'setBlack', 'findSlots', 'numberGrid',
      'slotFilled', 'slotHasCrossing', 'placeWord', 'removeWord', 'canFit']) {
      expect(typeof geom[fn]).toBe('function');
    }
  });

  it('setBlack mirrors 180 degrees', () => {
    const g = geom.setBlack(geom.makeEmptyGrid(3, 3), 0, 0);
    expect(g[0][0].black).toBe(true);
    expect(g[2][2].black).toBe(true);
  });

  it('numberGrid numbers word-start cells', () => {
    const g = geom.numberGrid(geom.makeEmptyGrid(1, 3));
    expect(g[0][0].number).toBe(1);
  });

  it('findSlots returns row-col-dir ids', () => {
    const slots = geom.findSlots(geom.makeEmptyGrid(3, 3), 3);
    expect(slots.some(s => s.id === '0-0-across')).toBe(true);
    expect(slots.some(s => s.id === '0-0-down')).toBe(true);
  });

  it('findSlots cells carry correct coordinates (regression: closure capture)', () => {
    // Guards the loop-variable-capture rewrite in the AMD conversion: each
    // across slot's cells must reference its own row, not the final loop row.
    const grid = geom.makeEmptyGrid(3, 3);
    const across = geom.findSlots(grid, 3).filter(s => s.dir === 'across');
    expect(across).toHaveLength(3);
    for (const slot of across) {
      expect(slot.cells.map(c => c.c)).toEqual([0, 1, 2]);
      expect(slot.cells.every(c => c.r === slot.row)).toBe(true);
    }
  });
});
