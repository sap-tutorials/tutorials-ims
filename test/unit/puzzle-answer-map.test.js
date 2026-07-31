/**
 * Unit test for the onAnswerChange letter-placement logic (Fix 1).
 *
 * The bug: onAnswerChange used _getAllSlots() (display items, no .cells) and
 * then called slot.cells.forEach() → TypeError: Cannot read properties of
 * undefined. The fix resolves the geometry slot via geom.findSlots().
 *
 * These tests verify both the placement logic AND that geom.findSlots() returns
 * slots with .cells, which is the precondition the fixed handler depends on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadGeom() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/crossword-geometry.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (_d, fn) => { mod = fn() } } } })
  return mod
}

/**
 * Pure simulation of the onAnswerChange placement logic (as fixed):
 *   geom.findSlots(grid, 2).find(s => s.id === sId)  → slot with .cells
 *   then iterate slot.cells to write/delete "r,c" keys in the answers map.
 */
function applyAnswerToMap(geom, grid, slotId, value, answers) {
  const slot = geom.findSlots(grid, 2).find(s => s.id === slotId)
  if (!slot) return answers
  const result = Object.assign({}, answers)
  slot.cells.forEach((cell, i) => {
    const key = cell.r + ',' + cell.c
    if (value[i]) {
      result[key] = value[i]
    } else {
      delete result[key]
    }
  })
  return result
}

describe('puzzle answer map — onAnswerChange placement logic', () => {
  const geom = loadGeom()

  it('geom.findSlots returns slots WITH .cells (the precondition the fix relies on)', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(3, 3))
    const slots = geom.findSlots(grid, 2)
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(Array.isArray(slot.cells)).toBe(true)
      expect(slot.cells.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('places letters into "r,c" answer map for a 3-cell across slot', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(1, 3))
    const slots = geom.findSlots(grid, 2)
    // The only slot is across: id '0-0-across', cells [{r:0,c:0},{r:0,c:1},{r:0,c:2}]
    const slot = slots.find(s => s.dir === 'across')
    expect(slot).toBeDefined()

    const result = applyAnswerToMap(geom, grid, slot.id, 'CAP', {})
    expect(result['0,0']).toBe('C')
    expect(result['0,1']).toBe('A')
    expect(result['0,2']).toBe('P')
  })

  it('deletes trailing keys when typed value is shorter than the slot', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(1, 5))
    const slots = geom.findSlots(grid, 2)
    const slot = slots.find(s => s.dir === 'across')
    expect(slot).toBeDefined()

    // Pre-populate all 5 positions
    const pre = { '0,0': 'H', '0,1': 'A', '0,2': 'N', '0,3': 'A', '0,4': 'S' }
    // User types only "HA" (2 chars) — trailing 3 keys must be deleted
    const result = applyAnswerToMap(geom, grid, slot.id, 'HA', pre)
    expect(result['0,0']).toBe('H')
    expect(result['0,1']).toBe('A')
    expect(result['0,2']).toBeUndefined()
    expect(result['0,3']).toBeUndefined()
    expect(result['0,4']).toBeUndefined()
  })

  it('clears all keys when value is empty string', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(1, 3))
    const slots = geom.findSlots(grid, 2)
    const slot = slots.find(s => s.dir === 'across')
    const pre = { '0,0': 'S', '0,1': 'A', '0,2': 'P' }
    const result = applyAnswerToMap(geom, grid, slot.id, '', pre)
    expect(result['0,0']).toBeUndefined()
    expect(result['0,1']).toBeUndefined()
    expect(result['0,2']).toBeUndefined()
  })

  it('does not throw for an unknown slotId (was TypeError before fix)', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(3, 3))
    // geom.findSlots().find() returns undefined for an unknown id — no .cells access
    expect(() => applyAnswerToMap(geom, grid, 'nonexistent-slot', 'ABC', {})).not.toThrow()
  })

  it('places letters for a down slot correctly', () => {
    const grid = geom.numberGrid(geom.makeEmptyGrid(3, 1))
    const slots = geom.findSlots(grid, 2)
    const slot = slots.find(s => s.dir === 'down')
    expect(slot).toBeDefined()

    const result = applyAnswerToMap(geom, grid, slot.id, 'BTP', {})
    expect(result['0,0']).toBe('B')
    expect(result['1,0']).toBe('T')
    expect(result['2,0']).toBe('P')
  })
})
