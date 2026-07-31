import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadSolver() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/solver-core.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}

describe('fill fallback', () => {
  it('solver-core solves the same shape the worker would', () => {
    const solver = loadSolver()
    const grid = Array.from({length:1},()=>Array.from({length:3},()=>({black:false,letter:'',number:null})))
    const slots=[{id:'0-0-across',dir:'across',len:3,cells:[{r:0,c:0},{r:0,c:1},{r:0,c:2}]}]
    const res = solver.solve({slots, words:['CAP'], grid, rows:1, cols:3, timeLimitMs:5000})
    expect(res.status).toBe('solved')
    expect(res.placed['0,2']).toBe('P')
  })
})
