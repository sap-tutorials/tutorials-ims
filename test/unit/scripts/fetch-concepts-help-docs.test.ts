// Phase 4.7 (#748 §4.7): fetch-concepts emits `helpDocs` YAML block into
// per-concept frontmatter when the /build/concepts payload includes a
// non-empty helpDocs[]. Hide-when-empty; pass-through of all fields.

import { describe, it, expect } from 'vitest'
import { frontmatter } from '../../../scripts/fetch-concepts.ts'

describe('fetch-concepts helpDocs frontmatter (Phase 4.7)', () => {
  it('emits helpDocs YAML block when non-empty', () => {
    const fm = frontmatter({
      slug: 'cap-service-handlers',
      name: 'CAP Service Handlers',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      helpDocs: [{
        slug: 'hd-cap-cloud-sap__docs__node_js__handlers',
        title: 'Handlers',
        url: 'https://cap.cloud.sap/docs/node.js/handlers',
        source: 'cap-cloud-sap',
        sourceLabel: 'CAP',
        anchor: 'before-create',
        anchorLabel: 'Before Create',
        snippet: 'Register a handler that fires before entity creation on this service.',
        product: 'cap',
      }],
    } as any)
    expect(fm).toContain('helpDocs:')
    expect(fm).toContain('slug: "hd-cap-cloud-sap__docs__node_js__handlers"')
    expect(fm).toContain('source: "cap-cloud-sap"')
    expect(fm).toContain('sourceLabel: "CAP"')
    expect(fm).toContain('anchor: "before-create"')
    expect(fm).toContain('anchorLabel: "Before Create"')
    expect(fm).toContain('snippet:')
  })

  it('omits the helpDocs key when the array is empty', () => {
    const fm = frontmatter({
      slug: 'lonely',
      name: 'Lonely',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      helpDocs: [],
    } as any)
    expect(fm).not.toContain('helpDocs:')
  })

  it('omits optional anchor + anchorLabel when null', () => {
    const fm = frontmatter({
      slug: 'x',
      name: 'X',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      helpDocs: [{
        slug: 'hd-help',
        title: 'CAP overview',
        url: 'https://help.sap.com/docs/cap/overview',
        source: 'help-sap-com',
        sourceLabel: 'SAP Help',
        anchor: null,
        anchorLabel: null,
        snippet: 'The SAP Cloud Application Programming Model at a glance.',
        product: 'cap',
      }],
    } as any)
    expect(fm).toContain('slug: "hd-help"')
    expect(fm).toContain('source: "help-sap-com"')
    // Nulls should NOT appear in the emitted YAML.
    expect(fm).not.toMatch(/anchor:\s*null/)
    expect(fm).not.toMatch(/anchorLabel:\s*null/)
  })

  it('escapes snippet quotes correctly', () => {
    const fm = frontmatter({
      slug: 'x',
      name: 'X',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      helpDocs: [{
        slug: 'hd-x',
        title: 'X',
        url: 'https://example.com/x',
        source: 'ui5-sap-com',
        sourceLabel: 'UI5',
        snippet: `A "quoted" phrase with a backslash \\ and newline
in it.`,
      }],
    } as any)
    // yamlEscape() wraps in "..." and escapes internal quotes/backslashes/newlines.
    expect(fm).toMatch(/snippet: "A \\"quoted\\" phrase/)
    expect(fm).toContain('\\\\')  // backslash escape
    expect(fm).toContain('\\n')   // newline escape
  })
})
