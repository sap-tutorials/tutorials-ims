// Phase 4.7 (#748 §4.8.3): widen NodeType and OtherResource to admit 'help-doc'.
// This is a compile-time smoke: if the union is not widened, the assertion
// fails at build. No runtime behavior tested here.
import { describe, it, expect } from 'vitest'
import type { NodeType, OtherResource } from '../../../hugo-apps/src/related-graph/types'

describe('NodeType — help-doc widening (Phase 4.7)', () => {
  it('admits help-doc as a NodeType', () => {
    const t: NodeType = 'help-doc'
    expect(t).toBe('help-doc')
  })

  it('admits a help-doc OtherResource with source/sourceLabel/anchor/anchorLabel/snippet/product', () => {
    const r: OtherResource = {
      type: 'help-doc',
      slug: 'hd-cap-cloud-sap__docs__node_js__handlers',
      title: 'Handlers',
      url: 'https://cap.cloud.sap/docs/node.js/handlers',
      source: 'cap-cloud-sap',
      sourceLabel: 'CAP',
      anchor: 'before-create',
      anchorLabel: 'Before Create',
      snippet: 'Register a handler that fires before entity creation...',
      product: 'cap',
    }
    expect(r.type).toBe('help-doc')
    expect(r.sourceLabel).toBe('CAP')
  })
})
