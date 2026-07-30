import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

// solver-core is a sap.ui.define AMD module; load it in a vm with a stubbed define.
function loadSolver() {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/solver-core.js'), 'utf8')
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
    // Both slots share (0,0); the only consistent pair is CAT across + COW down (both start C)
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
    expect(res.grid[0][0].letter).toBe('X') // pre-filled letter preserved
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
