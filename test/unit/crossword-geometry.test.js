import { expect, test } from 'vitest';
import { makeEmptyGrid, setBlack, numberGrid, findSlots } from '../../app/admin/puzzles/webapp/lib/crossword-geometry.js';

test('setBlack mirrors 180 degrees', () => {
  const g = setBlack(makeEmptyGrid(3, 3), 0, 0);
  expect(g[0][0].black).toBe(true);
  expect(g[2][2].black).toBe(true);
});

test('numberGrid numbers word-start cells', () => {
  const g = numberGrid(makeEmptyGrid(1, 3));
  expect(g[0][0].number).toBe(1);
});

test('findSlots returns row-col-dir ids', () => {
  const slots = findSlots(makeEmptyGrid(3, 3), 3);
  expect(slots.some(s => s.id === '0-0-across')).toBe(true);
});
