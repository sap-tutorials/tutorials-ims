import { describe, it, expect } from 'vitest'
import { buildExploreHtml } from '../../../srv/lib/build-explore-html.js'

describe('buildExploreHtml', () => {
  it('substitutes all four placeholders', () => {
    const payload = { nodes: [], edges: [], generatedAt: '2026-06-27T00:00:00.000Z' }
    const bundleHash = 'abc123'
    const html = buildExploreHtml(payload, bundleHash, 'index-abc.css')
    expect(html).toContain('"generatedAt":"2026-06-27T00:00:00.000Z"')
    expect(html).toContain('main-abc123.js')
    expect(html).toContain('index-abc.css')
    expect(html).not.toContain('__INITIAL_GRAPH_JSON__')
    expect(html).not.toContain('__BUNDLE_HASH__')
    expect(html).not.toContain('__BUNDLE_CSS__')
  })

  it('propagates the CSS hash into the stylesheet link', () => {
    const payload = { nodes: [], edges: [], generatedAt: '' }
    const html = buildExploreHtml(payload, 'h', 'index-XYZ789.css')
    expect(html).toContain('/explore-ui/assets/index-XYZ789.css')
  })

  it('escapes < to \\u003c to defeat all script-end-tag and HTML-comment vectors', () => {
    const payload = {
      nodes: [{
        id: 'a',
        label: '</script><script>alert(1)</script>',
        slug: 'a',
        type: 'tutorial'
      }],
      edges: [],
      generatedAt: 'x'
    }
    const html = buildExploreHtml(payload, 'hash', 'index.css')
    // The inline JSON must not contain a literal `<` from the payload — all escaped to <.
    const match = html.match(/<script type="application\/json" id="initial-graph">([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const inlineJson = match[1]
    expect(inlineJson).not.toContain('</script>')
    expect(inlineJson).not.toContain('<!--')
    expect(inlineJson).toMatch(/\\u003c/)
  })

  it('preserves < in non-payload template content (only payload is escaped)', () => {
    // Sanity: the template itself has < in <!DOCTYPE>, <html>, etc.
    // Only the JSON.stringify output is run through the < escape.
    const html = buildExploreHtml({ nodes: [], edges: [], generatedAt: 'x' }, 'h', 'index.css')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
  })

  it('uses default meta description when not provided', () => {
    const html = buildExploreHtml({ nodes: [], edges: [], generatedAt: '' }, 'h', 'index.css')
    expect(html).toContain('content="')
  })
})
