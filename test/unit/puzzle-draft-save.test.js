import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

// Load the UI5 AMD module the same way puzzle-fill-controller.test.js loads
// solver-core.js — no browser/UI5 runtime needed.
function loadDraftSave() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin/puzzles/webapp/lib/draft-save.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (deps, fn) => { mod = fn() } } } })
  return mod
}

// Minimal Response-like stub.
function res(status, body) {
  const ok = status >= 200 && status < 300
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const HEADERS = { 'x-csrf-token': 't' }
const FIELDS = { title: 'X', slug: 'x', status: 'ACTIVE', layout: '{}', solution: '{}' }

describe('performPuzzleSave — issue #1650 bug 3', () => {
  it('recovers from a 409 DRAFT_ALREADY_EXISTS by resuming the existing draft', async () => {
    const calls = []
    const fetchFn = (url, opts) => {
      calls.push({ url, method: opts.method })
      if (/draftEdit/.test(url)) {
        return res(409, { error: { message: 'A draft for this entity already exists', code: 'DRAFT_ALREADY_EXISTS' } })
      }
      if (opts.method === 'PATCH') return res(200, {})
      if (/draftActivate/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    const active = await performPuzzleSave({ fetchFn, headers: HEADERS, editId: 'p1', fields: FIELDS })

    expect(active.slug).toBe('x')
    // The draft (keyed on the active ID) was PATCHed and activated despite the 409.
    expect(calls.some(c => c.method === 'PATCH' && /ID=p1,IsActiveEntity=false/.test(c.url))).toBe(true)
    expect(calls.some(c => /ID=p1,IsActiveEntity=false\)\/AdminService.draftActivate/.test(c.url))).toBe(true)
  })

  it('happy-path update: draftEdit → PATCH → activate', async () => {
    const calls = []
    const fetchFn = (url, opts) => {
      calls.push(url)
      if (/draftEdit/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: false })
      if (opts.method === 'PATCH') return res(200, {})
      if (/draftActivate/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    const active = await performPuzzleSave({ fetchFn, headers: HEADERS, editId: 'p1', fields: FIELDS })
    expect(active.IsActiveEntity).toBe(true)
    expect(calls.some(u => /draftEdit/.test(u))).toBe(true)
  })

  it('re-throws a non-409 draftEdit failure', async () => {
    const fetchFn = (url) => {
      if (/draftEdit/.test(url)) return res(500, 'boom')
      throw new Error('should not reach ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    await expect(performPuzzleSave({ fetchFn, headers: HEADERS, editId: 'p1', fields: FIELDS }))
      .rejects.toThrow(/draftEdit HTTP 500/)
  })

  it('re-throws a 409 that is NOT DRAFT_ALREADY_EXISTS (e.g. locked by another user)', async () => {
    const fetchFn = (url) => {
      if (/draftEdit/.test(url)) return res(409, { error: { message: 'locked by another user', code: 'DRAFT_LOCKED' } })
      throw new Error('should not reach ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    await expect(performPuzzleSave({ fetchFn, headers: HEADERS, editId: 'p1', fields: FIELDS }))
      .rejects.toThrow(/draftEdit HTTP 409/)
  })

  it('create-path: POST draft → activate', async () => {
    const calls = []
    const fetchFn = (url, opts) => {
      calls.push({ url, method: opts.method })
      if (url === '/admin/Puzzles' && opts.method === 'POST') return res(201, { ID: 'new1', IsActiveEntity: false })
      if (/draftActivate/.test(url)) return res(200, { ID: 'new1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    const active = await performPuzzleSave({ fetchFn, headers: HEADERS, editId: null, fields: FIELDS })
    expect(active.ID).toBe('new1')
    expect(calls[0]).toEqual({ url: '/admin/Puzzles', method: 'POST' })
  })
})
