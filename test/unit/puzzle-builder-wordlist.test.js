import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function loadIo() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/puzzle-io.js'), 'utf8')
  let mod; vm.runInNewContext(src, { sap: { ui: { define: (d, fn) => { mod = fn() } } } })
  return mod
}

describe('wordlist wiring', () => {
  it('countWords matches parseWordList length after upload text', () => {
    const io = loadIo()
    const text = 'SAP\nCAP\nBTP,HANA;FIORI'
    expect(io.countWords(text)).toBe(io.parseWordList(text).length)
    expect(io.parseWordList(text)).toContain('FIORI')
  })
})
