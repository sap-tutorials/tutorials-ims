import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function solverSrc() {
  return readFileSync(
    path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/solver-core.js'), 'utf8')
}

// solver-core is a sap.ui.define AMD module; load it in a vm with a stubbed define.
function loadSolver() {
  const src = solverSrc()
  let mod
  // UMD module: prefer the AMD path by providing sap.ui.define; capture the export.
  const sandbox = { sap: { ui: { define: (deps, fn) => { mod = fn() } } }, self: {} }
  vm.runInNewContext(src, sandbox)
  return mod || sandbox.self.SolverCore
}

// A 3x1 across slot + a 3x1 down slot crossing at (0,0).
function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ black: false, letter: '', number: null })))
}

describe('solver-core', () => {
  it('loads via the worker/importScripts UMD branch (no sap global)', () => {
    const src = solverSrc()
    const sandbox = { self: {} }
    vm.runInNewContext(src, sandbox)
    expect(typeof sandbox.self.SolverCore.solve).toBe('function')
  })

  it('fills two crossing slots from a word list', () => {
    const solver = loadSolver()
    const grid = makeGrid(3, 3)
    // black out everything except the top row and left column
    grid[1][1].black = true; grid[1][2].black = true
    grid[2][1].black = true; grid[2][2].black = true
    const slots = [
      { id: '0-0-across', dir: 'across', len: 3, cells: [{r:0,c:0},{r:0,c:1},{r:0,c:2}] },
      { id: '0-0-down',   dir: 'down',   len: 3, cells: [{r:0,c:0},{r:1,c:0},{r:2,c:0}] }
    ]
    const res = solver.solve({
      slots, words: ['CAT', 'COW', 'DOG'], grid, rows: 3, cols: 3, timeLimitMs: 5000
    })
    expect(res.status).toBe('solved')
    // Result is deterministic: solver tries words in list order; 'across' slot is
    // processed first, 'CAT' fits → placed across; only 'COW' then satisfies the
    // crossing constraint at (0,0). DOG is never tried for the across slot because
    // CAT is accepted first.
    expect(res.placed['0,0']).toBe('C')
    expect(res.placed['0,1']).toBe('A')
    expect(res.placed['0,2']).toBe('T')
    expect(res.placed['1,0']).toBe('O')
    expect(res.placed['2,0']).toBe('W')
  })

  it('respects pre-filled letters and reports nosolution when impossible', () => {
    const solver = loadSolver()
    const grid = makeGrid(1, 3)
    grid[0][0].letter = 'X' // no word starts with X in the list
    const slots = [{ id:'0-0-across', dir:'across', len:3, cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}] }]
    const res = solver.solve({ slots, words:['CAT','DOG'], grid, rows:1, cols:3, timeLimitMs:5000 })
    expect(res.status).toBe('nosolution')
    expect(res.grid[0][0].letter).toBe('X') // pre-filled letter preserved in grid
    expect(res.placed['0,0']).toBeUndefined() // pre-filled key excluded from placed
  })

  it('reports timeout when the attempt budget is exhausted', () => {
    const solver = loadSolver()
    const grid = makeGrid(1, 3)
    const slots = [{ id:'0-0-across', dir:'across', len:3, cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}] }]
    // timeLimitMs=0 with the default counter → first nowFn() call exceeds budget.
    const res = solver.solve({ slots, words:['CAT'], grid, rows:1, cols:3, timeLimitMs:0 })
    expect(res.status).toBe('timeout')
  })
})
