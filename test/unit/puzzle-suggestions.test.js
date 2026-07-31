import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function load(f) {
  const src = readFileSync(path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/' + f), 'utf8')
  let m
  vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { m = fn() } } } })
  return m
}

describe('suggestions', () => {
  it('matches words to a slot pattern honoring crossing letters', () => {
    const solver = load('solver-core.js')
    const letters = { '0,0': 'C' } // first cell fixed to C
    const slot = { id: '0-0-across', dir: 'across', len: 3, cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }] }
    const words = ['CAT', 'DOG', 'COW']
    const matches = words.filter(w => solver.fits(slot, w, letters))
    expect(matches).toEqual(['CAT', 'COW'])
  })
})
