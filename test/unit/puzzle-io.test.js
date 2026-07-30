import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadIo() {
  const src = readFileSync(
    path.resolve(__dirname, '../../app/admin/puzzles/webapp/lib/puzzle-io.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}

describe('puzzle-io', () => {
  it('parses newline/comma/semicolon separated words, uppercased, A-Z only', () => {
    const io = loadIo()
    expect(io.parseWordList('cat, dog\r\nCOW; fi-sh')).toEqual(['CAT','DOG','COW','FISH'])
    expect(io.countWords('a\nb\nc')).toBe(3)
  })

  it('round-trips export → import', () => {
    const io = loadIo()
    const state = {
      rows: 2, cols: 2,
      grid: [[{black:false,number:1},{black:true,number:null}],
             [{black:false,number:2},{black:false,number:null}]],
      wordText: 'AB\nCD', clues: {'0-0-across':'x'}, hints: {'0-0-across':'anagram'},
      wordLengths: {'0-0-across':2}, answers: {'0,0':'A'}, title: 'T', slug: 't'
    }
    const exported = io.exportPuzzle(state)
    expect(exported.formatVersion).toBe(1)
    const res = io.importPuzzle(JSON.parse(JSON.stringify(exported)))
    expect(res.ok).toBe(true)
    expect(res.state.answers['0,0']).toBe('A')
    expect(res.state.clues['0-0-across']).toBe('x')
  })

  it('rejects malformed import', () => {
    const io = loadIo()
    expect(io.importPuzzle({ rows: 2 }).ok).toBe(false)
    expect(io.importPuzzle({ rows: 2, cols: 2, grid: [[{}]] }).ok).toBe(false) // wrong dims
  })
})
