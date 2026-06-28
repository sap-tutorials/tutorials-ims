import { describe, it, expect } from 'vitest'
import { buildExploreHtml } from '../../../srv/lib/build-explore-html.js'

describe('buildExploreHtml', () => {
  it('substitutes the three placeholders', () => {
    const payload = { nodes: [], edges: [], generatedAt: '2026-06-27T00:00:00.000Z' }
    const bundleHash = 'abc123'
    const html = buildExploreHtml(payload, bundleHash)
    expect(html).toContain('"generatedAt":"2026-06-27T00:00:00.000Z"')
    expect(html).toContain('main-abc123.js')
    expect(html).not.toContain('__INITIAL_GRAPH_JSON__')
    expect(html).not.toContain('__BUNDLE_HASH__')
  })

  it('escapes </script> inside the inline JSON to prevent XSS', () => {
    const payload = { nodes: [{ id: 'a', label: '</script><script>alert(1)</script>', slug: 'a', type: 'tutorial' }], edges: [], generatedAt: 'x' }
    const html = buildExploreHtml(payload, 'hash')
    expect(html).not.toContain('</script><script>alert')
    expect(html).toMatch(/<\\\/script>/)
  })

  it('uses default meta description when not provided', () => {
    const html = buildExploreHtml({ nodes: [], edges: [], generatedAt: '' }, 'h')
    expect(html).toContain('content="')
  })
})
