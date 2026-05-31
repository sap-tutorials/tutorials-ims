// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

vi.mock('../useQuerySpec', () => {
  const spec = ref({
    version: 1,
    from: { entity: 'Users', alias: 'u' },
    select: [{ kind: 'column', id: 's1', ref: { alias: 'u', column: 'ID' } }],
    filterTree: null, joins: [], groupBy: [], orderBy: [], limit: 10,
  })
  return { useQuerySpec: () => ({ spec, mode: ref('builder') }) }
})

vi.mock('../../api/entities', () => ({
  getCachedEntityMetadata: async () => ([
    {
      name: 'Users', sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS', label: 'Users', description: '',
      columns: [
        { name: 'ID', type: 'cds.UUID', nullable: false, length: null, pii: false },
        { name: 'email', type: 'cds.String', nullable: true, length: 255, pii: true },
      ],
    },
  ]),
}))

import { useJouleContext, _resetForTest } from '../useJouleContext'

beforeEach(() => { _resetForTest() })

describe('useJouleContext', () => {
  it('builds pageContext with currentSpec and redacted lastResult', async () => {
    const ctx = useJouleContext()
    ctx.setLastResult({ entityName: 'Users', columns: ['ID', 'email'], rows: [['u1', 'a@b.com']], rowCount: 1, truncated: false })
    const pc = await ctx.build()
    expect(pc.kind).toBe('admin')
    expect(pc.tool).toBe('analytics-builder')
    expect(pc.currentSpec.from.entity).toBe('Users')
    expect(pc.lastResult.rows[0]).toEqual(['u1', '[REDACTED]'])
    expect(pc.lastResult.redactedColumns).toEqual(['email'])
  })

  it('omits lastResult when none has been recorded', async () => {
    const ctx = useJouleContext()
    const pc = await ctx.build()
    expect(pc.lastResult).toBeUndefined()
  })
})
