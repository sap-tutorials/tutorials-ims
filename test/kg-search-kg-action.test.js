import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

// The KG service gate (before('*')) checks KNOWLEDGE_GRAPH_ENABLED — flip it
// on before the in-memory server starts, otherwise all actions return 503.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true'

// Spins up the full CAP service stack in-memory — minimal cost since
// SQLite is in-memory and the embedding calls are stubbed by the handler's
// own fail-open (no real embeddings in unit mode).
const project = cds.test('serve', '--project', '.', '--in-memory')

describe('KnowledgeGraphService.searchKG action', () => {
  it('exposes searchKG as an unbound action on the service', async () => {
    const kg = cds.services['KnowledgeGraphService'] || await cds.connect.to('KnowledgeGraphService')
    const action = kg.operations?.searchKG || kg.definition?.actions?.searchKG
    expect(action).toBeDefined()
  })

  it('returns the { concepts, tutorials } shape even for a garbage term', async () => {
    const kg = cds.services['KnowledgeGraphService'] || await cds.connect.to('KnowledgeGraphService')
    const out = await kg.send('searchKG', { term: 'zzz-nothing-here-xyz-1036' })
    expect(out).toHaveProperty('concepts')
    expect(out).toHaveProperty('tutorials')
    expect(Array.isArray(out.concepts)).toBe(true)
    expect(Array.isArray(out.tutorials)).toBe(true)
  })
})
