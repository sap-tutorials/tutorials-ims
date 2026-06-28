// test/unit/srv/kg-service-auth.test.js
//
// Contract test: KnowledgeGraphService's read surface is anonymous;
// admin actions and writable projections remain scope-gated. The CDS
// service-level @requires drop is intentional — readers (incl. the
// public /tutorials/* sidebar and /explore page) must reach the read
// endpoints without sign-in.

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import path from 'node:path'

describe('KnowledgeGraphService auth annotations', () => {
  let csn
  beforeAll(async () => {
    csn = await cds.load(path.resolve(import.meta.dirname, '../../../srv/knowledge-graph-service.cds'))
  })

  it('drops the service-level @requires', () => {
    const svc = csn.definitions['KnowledgeGraphService']
    // The annotation is removed entirely; the only @requires entries
    // sit on the individual admin actions.
    expect(svc['@requires']).toBeUndefined()
  })

  it('keeps KnowledgeGraph.Admin on every curation action', () => {
    // CSN may emit @requires as either a string or an array depending on
    // the source syntax. Normalize so the assertion is robust to either.
    const requiresList = (op) => {
      const r = op?.['@requires']
      if (r == null) return []
      return Array.isArray(r) ? r : [r]
    }

    const ADMIN_ACTIONS = [
      'runSparql', 'mergeConcepts', 'previewMerges',
      'vetoConcept', 'vetoEdge', 'triggerGraphRebuild',
    ]
    for (const name of ADMIN_ACTIONS) {
      const op = csn.definitions[`KnowledgeGraphService.${name}`]
      expect(op, name).toBeTruthy()
      expect(requiresList(op), name).toContain('KnowledgeGraph.Admin')
    }

    // Every bound action on Concepts must carry the admin scope. We
    // enumerate rather than hardcode names so a future bound action
    // added without @requires fails this contract test.
    const bound = csn.definitions['KnowledgeGraphService.Concepts']?.actions ?? {}
    const boundNames = Object.keys(bound)
    expect(boundNames.length, 'bound actions on Concepts').toBeGreaterThan(0)
    for (const name of boundNames) {
      expect(requiresList(bound[name]), `bound action ${name}`).toContain('KnowledgeGraph.Admin')
    }
  })

  it('reader operations carry no @requires (anonymous-allowed)', () => {
    const READER_OPS = ['neighborhood', 'pathBetween', 'conceptsForUser']
    for (const name of READER_OPS) {
      const op = csn.definitions[`KnowledgeGraphService.${name}`]
      expect(op, name).toBeTruthy()
      expect(op['@requires'], name).toBeUndefined()
    }
  })
})
