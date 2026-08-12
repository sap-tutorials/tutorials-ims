import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Regression guard — issue #1650 (reopened).
//
// developers.sap.com (PROD) is fronted by Akamai, which rejects the bare
// `PATCH` / `PUT` / `DELETE` HTTP verbs at the edge with `501 Unsupported
// Request` before the request reaches the approuter/CAP origin. Fiori Elements
// admin pages are unaffected because the UI5 OData V4 model batches EVERY write
// into `POST /admin/$batch` (Akamai allows POST). Hand-rolled
// `fetch(url, { method: "PATCH" })` calls in the admin controllers do NOT batch
// and therefore 501 on PROD (CREATE via POST works; UPDATE via PATCH does not).
//
// All admin writes must go through the shared `odata-batch.batchWrite` helper
// (`sap/tutorials/admin/shell/lib/odata-batch`), which tunnels the write through
// `POST /<service>$batch`. This test fails if a raw verb reappears.

const ADMIN = path.resolve(__dirname, '../../app/admin')

function jsFilesUnder(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFilesUnder(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

// Matches a fetch() whose options literal sets method to a blocked verb, e.g.
//   fetch("/admin/Foo", { method: "PATCH", ... })
// The batchWrite({ ..., method: "PATCH" }) form is NOT matched (not a fetch()).
const RAW_VERB = /fetch\(\s*[^,]+,\s*\{[^}]*?method:\s*["'](PATCH|PUT|DELETE)["']/

describe('admin controllers never issue a bare PATCH/PUT/DELETE fetch (issue #1650 — Akamai 501)', () => {
  it('routes every write through odata-batch.batchWrite (POST /$batch)', () => {
    const offenders = []
    for (const file of jsFilesUnder(ADMIN)) {
      if (RAW_VERB.test(readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(ADMIN, file).replace(/\\/g, '/'))
      }
    }
    expect(
      offenders,
      `Bare PATCH/PUT/DELETE fetch() found (will 501 at the Akamai edge on PROD) in:\n  ${offenders.join('\n  ')}\n` +
      `Route the write through sap/tutorials/admin/shell/lib/odata-batch batchWrite().`
    ).toEqual([])
  })
})
