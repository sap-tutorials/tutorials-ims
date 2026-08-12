import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

// Load the UI5 AMD module the same way puzzle-draft-save.test.js loads
// draft-save.js — no browser/UI5 runtime needed. The module must be a
// zero-dep sap.ui.define([], fn).
function loadBatch() {
  const src = readFileSync(path.resolve(__dirname,
    '../../app/admin-shell/webapp/lib/odata-batch.js'), 'utf8')
  let mod
  vm.runInNewContext(src, { sap: { ui: { define: (deps, fn) => { mod = fn() } } } })
  return mod
}

// Minimal Response-like stub for the OUTER $batch POST.
function res(status, body) {
  const ok = status >= 200 && status < 300
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const HEADERS = { 'x-csrf-token': 't', 'Content-Type': 'application/json', Accept: 'application/json' }

describe('odata-batch.batchWrite — tunnel PATCH/DELETE through POST /$batch (issue #1650)', () => {
  it('sends a PATCH as a JSON $batch POST to <service>$batch (never a bare PATCH verb)', async () => {
    let captured
    const fetchFn = (url, opts) => {
      captured = { url, opts }
      return res(200, { responses: [{ id: 'r1', status: 200, body: { ID: 'p1', slug: 'x' } }] })
    }
    const { batchWrite } = loadBatch()
    const r = await batchWrite({
      fetchFn, service: '/admin/', url: 'Puzzles(ID=p1,IsActiveEntity=false)',
      method: 'PATCH', headers: HEADERS, body: { slug: 'x' }
    })

    // Outer request is a POST to the $batch endpoint — Akamai-safe.
    expect(captured.url).toBe('/admin/$batch')
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.credentials).toBe('include')
    // CSRF token carried on the outer POST.
    expect(captured.opts.headers['x-csrf-token']).toBe('t')

    const sent = JSON.parse(captured.opts.body)
    expect(sent.requests).toHaveLength(1)
    const sub = sent.requests[0]
    expect(sub.method).toBe('PATCH')
    // Sub-request URL is RELATIVE to the $batch endpoint (no leading slash, no /admin/).
    expect(sub.url).toBe('Puzzles(ID=p1,IsActiveEntity=false)')
    expect(sub.body).toEqual({ slug: 'x' })

    // Returns a Response-like reflecting the INNER response.
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ID: 'p1', slug: 'x' })
  })

  it('surfaces an inner error status as a non-ok Response-like', async () => {
    const fetchFn = () => res(200, {
      responses: [{ id: 'r1', status: 400, body: { error: { message: 'bad slug' } } }]
    })
    const { batchWrite } = loadBatch()
    const r = await batchWrite({
      fetchFn, service: '/admin/', url: 'Puzzles(ID=p1,IsActiveEntity=false)',
      method: 'PATCH', headers: HEADERS, body: { slug: '' }
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(await r.text()).toMatch(/bad slug/)
  })

  it('propagates an outer $batch failure (auth/CSRF) as a non-ok Response-like', async () => {
    const fetchFn = () => res(403, 'CSRF token validation failed')
    const { batchWrite } = loadBatch()
    const r = await batchWrite({
      fetchFn, service: '/admin/', url: 'ChatSettings', method: 'PATCH',
      headers: HEADERS, body: { alertsEnabled: true }
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(await r.text()).toMatch(/CSRF/)
  })

  it('DELETE carries no body sub-request and still tunnels as POST /$batch', async () => {
    let captured
    const fetchFn = (url, opts) => {
      captured = { url, opts }
      return res(200, { responses: [{ id: 'r1', status: 204 }] })
    }
    const { batchWrite } = loadBatch()
    const r = await batchWrite({
      fetchFn, service: '/admin/', url: "Secrets(name='FOO')", method: 'DELETE', headers: HEADERS
    })
    expect(captured.url).toBe('/admin/$batch')
    expect(captured.opts.method).toBe('POST')
    const sub = JSON.parse(captured.opts.body).requests[0]
    expect(sub.method).toBe('DELETE')
    expect(sub.body).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.status).toBe(204)
  })

  it('treats a malformed $batch envelope (no responses) as a non-ok Response-like', async () => {
    const fetchFn = () => res(200, { notResponses: [] })
    const { batchWrite } = loadBatch()
    const r = await batchWrite({
      fetchFn, service: '/admin/', url: 'ChatSettings', method: 'PATCH', headers: HEADERS, body: {}
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBeGreaterThanOrEqual(500)
  })
})
