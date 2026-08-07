// test/unit/scripts/seed-browse-from-deployed.test.ts
//
// Guards scripts/seed-browse-from-deployed.ts — the fix for the "catalog-only
// rebuild wipes /browse/" incident (root-caused 2026-08-07). That script
// re-hydrates hugo/data/browse.json from the browse page the approuter is
// currently serving, so a catalog-only rebuild (which skips fetch-tutorials.ts
// → writeBrowseData) doesn't ship an empty browse/index.html that the
// /admin/rebuild atomic STATIC_DIR swap would clobber the good page with.
//
// These lock the extraction of the inlined `<script id="browse-data">` blob,
// which is the load-bearing bit: it must survive Hugo's quoted/unquoted id
// minification and reject anything that isn't a real populated payload.

import { describe, it, expect } from 'vitest'
import { extractBrowseData } from '../../../scripts/seed-browse-from-deployed'

const payload = {
  all: [{ type: 'tutorial', id: 'abap-create-project', title: 'Create an ABAP Project' }],
  featured: ['mission-1'],
  recent: ['abap-create-project'],
  categories: [{ slug: 'abap', label: 'ABAP' }],
  buildAt: '2026-08-07T20:05:56.078Z',
}

function wrap(json: string, opts: { quoted?: boolean; minified?: boolean } = {}): string {
  const id = opts.quoted === false ? 'id=browse-data' : 'id="browse-data"'
  const tag = `<script ${id} type="application/json">${json}</script>`
  return opts.minified
    ? `<!doctype html><html><body><main>${tag}</main></body></html>`
    : `<!doctype html>\n<html>\n<body>\n  <main id="browse-results"></main>\n  ${tag}\n</body>\n</html>\n`
}

describe('extractBrowseData', () => {
  it('extracts the payload from a quoted-id browse-data script', () => {
    const out = extractBrowseData(wrap(JSON.stringify(payload)))
    expect(out.all).toHaveLength(1)
    expect(out.buildAt).toBe('2026-08-07T20:05:56.078Z')
    expect(out.categories).toHaveLength(1)
  })

  it('extracts from an UNQUOTED id (Hugo --minify emits id=browse-data)', () => {
    const out = extractBrowseData(wrap(JSON.stringify(payload), { quoted: false, minified: true }))
    expect(out.all).toHaveLength(1)
  })

  it('round-trips a large single-line minified blob', () => {
    const big = { ...payload, all: Array.from({ length: 1952 }, (_, i) => ({ type: 'tutorial', id: `t-${i}`, title: `T ${i}` })) }
    const out = extractBrowseData(wrap(JSON.stringify(big), { minified: true }))
    expect(out.all).toHaveLength(1952)
  })

  it('preserves an empty payload as-is (empty-detection belongs to main, not the extractor)', () => {
    const out = extractBrowseData(wrap(JSON.stringify({ all: [], featured: [], recent: [], categories: [], buildAt: '' })))
    expect(out.all).toHaveLength(0)
  })

  it('throws when there is no browse-data script (would otherwise ship empty)', () => {
    expect(() => extractBrowseData('<html><body>no data here</body></html>')).toThrow(/no <script id="browse-data">/)
  })

  it('throws on malformed JSON rather than returning junk', () => {
    expect(() => extractBrowseData(wrap('{ not: valid json, }'))).toThrow(/not valid JSON/)
  })

  it('throws when the blob parses to a non-object (e.g. a bare array/number)', () => {
    expect(() => extractBrowseData(wrap('42'))).toThrow(/did not parse to an object/)
  })
})
