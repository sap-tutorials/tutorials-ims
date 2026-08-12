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

// The PATCH step is tunnelled through the shared batchWrite helper (issue #1650
// reopened — a bare PATCH 501s at the Akamai edge). Mock it here: record the
// call and return a Response-like, mirroring the real helper's contract.
function makeBatchWrite(calls, statusByUrl) {
  return function (opts) {
    calls.push({ via: 'batch', url: opts.url, method: opts.method, body: opts.body })
    const status = (statusByUrl && statusByUrl[opts.url]) || 200
    const ok = status >= 200 && status < 300
    return Promise.resolve({
      ok, status,
      json: () => Promise.resolve(ok ? {} : { error: { message: 'boom' } }),
      text: () => Promise.resolve(ok ? '' : 'boom'),
    })
  }
}

describe('performPuzzleSave — issue #1650 bug 3', () => {
  it('recovers from a 409 DRAFT_ALREADY_EXISTS by resuming the existing draft', async () => {
    const calls = []
    const fetchFn = (url, opts) => {
      calls.push({ url, method: opts.method })
      if (/draftEdit/.test(url)) {
        return res(409, { error: { message: 'A draft for this entity already exists', code: 'DRAFT_ALREADY_EXISTS' } })
      }
      if (/draftActivate/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    const batchWrite = makeBatchWrite(calls)
    const active = await performPuzzleSave({ fetchFn, batchWrite, headers: HEADERS, editId: 'p1', fields: FIELDS })

    expect(active.slug).toBe('x')
    // The draft (keyed on the active ID) was PATCHed via $batch and activated despite the 409.
    expect(calls.some(c => c.via === 'batch' && c.method === 'PATCH' && /ID=p1,IsActiveEntity=false/.test(c.url))).toBe(true)
    expect(calls.some(c => /ID=p1,IsActiveEntity=false\)\/AdminService.draftActivate/.test(c.url))).toBe(true)
  })

  it('happy-path update: draftEdit → PATCH(via $batch) → activate', async () => {
    const calls = []
    const fetchFn = (url) => {
      calls.push(url)
      if (/draftEdit/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: false })
      if (/draftActivate/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const batchCalls = []
    const { performPuzzleSave } = loadDraftSave()
    const batchWrite = makeBatchWrite(batchCalls)
    const active = await performPuzzleSave({ fetchFn, batchWrite, headers: HEADERS, editId: 'p1', fields: FIELDS })
    expect(active.IsActiveEntity).toBe(true)
    expect(calls.some(u => /draftEdit/.test(u))).toBe(true)
    // PATCH went through the batch helper, NEVER as a bare fetch PATCH verb.
    expect(batchCalls.some(c => c.method === 'PATCH')).toBe(true)
    expect(batchCalls[0].body).toEqual(FIELDS)
  })

  it('re-throws a non-409 draftEdit failure', async () => {
    const fetchFn = (url) => {
      if (/draftEdit/.test(url)) return res(500, 'boom')
      throw new Error('should not reach ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    await expect(performPuzzleSave({ fetchFn, batchWrite: makeBatchWrite([]), headers: HEADERS, editId: 'p1', fields: FIELDS }))
      .rejects.toThrow(/draftEdit HTTP 500/)
  })

  it('re-throws a 409 that is NOT DRAFT_ALREADY_EXISTS (e.g. locked by another user)', async () => {
    const fetchFn = (url) => {
      if (/draftEdit/.test(url)) return res(409, { error: { message: 'locked by another user', code: 'DRAFT_LOCKED' } })
      throw new Error('should not reach ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    await expect(performPuzzleSave({ fetchFn, batchWrite: makeBatchWrite([]), headers: HEADERS, editId: 'p1', fields: FIELDS }))
      .rejects.toThrow(/draftEdit HTTP 409/)
  })

  it('surfaces a $batch PATCH failure (e.g. Akamai/CSRF) as a PATCH draft error', async () => {
    const fetchFn = (url) => {
      if (/draftEdit/.test(url)) return res(200, { ID: 'p1', IsActiveEntity: false })
      throw new Error('should not reach ' + url)
    }
    const { performPuzzleSave } = loadDraftSave()
    const batchWrite = makeBatchWrite([], { 'Puzzles(ID=p1,IsActiveEntity=false)': 403 })
    await expect(performPuzzleSave({ fetchFn, batchWrite, headers: HEADERS, editId: 'p1', fields: FIELDS }))
      .rejects.toThrow(/PATCH draft HTTP 403/)
  })

  it('create-path: POST draft → activate (no PATCH/$batch)', async () => {
    const calls = []
    const fetchFn = (url, opts) => {
      calls.push({ url, method: opts.method })
      if (url === '/admin/Puzzles' && opts.method === 'POST') return res(201, { ID: 'new1', IsActiveEntity: false })
      if (/draftActivate/.test(url)) return res(200, { ID: 'new1', IsActiveEntity: true, slug: 'x' })
      throw new Error('unexpected ' + url)
    }
    const batchCalls = []
    const { performPuzzleSave } = loadDraftSave()
    const active = await performPuzzleSave({ fetchFn, batchWrite: makeBatchWrite(batchCalls), headers: HEADERS, editId: null, fields: FIELDS })
    expect(active.ID).toBe('new1')
    expect(calls[0]).toEqual({ url: '/admin/Puzzles', method: 'POST' })
    expect(batchCalls).toHaveLength(0)
  })
})
