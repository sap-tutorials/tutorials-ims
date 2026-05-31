import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the entities API so we don't hit a server.
vi.mock('../../api/entities', () => ({
  getCachedEntityMetadata: vi.fn(async () => ([
    {
      name: 'Tasks',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_TASKS',
      label: 'Tasks',
      description: '',
      columns: [
        { name: 'id', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'status', type: 'cds.String', hanaType: 'NVARCHAR(255)', nullable: true, length: 255, filterMode: 'enum', filterSample: true, pii: false },
      ],
      associations: [],
    },
    {
      name: 'TaskRecords',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS',
      label: 'Task records',
      description: '',
      columns: [
        { name: 'ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'user_ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: true, length: null, filterMode: 'free', filterSample: false, pii: false },
      ],
      associations: [
        { name: 'user', targetEntity: 'Users', cardinality: 'to-one', onLocal: ['user_ID'], onTarget: ['ID'] },
      ],
    },
    {
      name: 'Users',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS',
      label: 'Users',
      description: '',
      columns: [
        { name: 'ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'email', type: 'cds.String', hanaType: 'NVARCHAR(255)', nullable: true, length: 255, filterMode: 'free', filterSample: false, pii: true },
      ],
      associations: [],
    },
  ])),
}))

vi.mock('../../api/distinct', () => ({
  sampleDistinct: vi.fn(async (table: string, column: string) => ({
    values: [`${table}.${column}.1`, `${table}.${column}.2`],
    truncated: false,
  })),
}))

// Import AFTER vi.mock so the mocks are in place.
const { useEntityGraph, _resetForTest } = await import('../useEntityGraph')

describe('useEntityGraph', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
  })

  it('load() populates entities and entityMap', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.entities.value.length).toBe(3)
    expect(g.entityMap.value.has('Tasks')).toBe(true)
  })

  it('builds entityMap with column metadata in the validator-expected shape', async () => {
    const g = useEntityGraph()
    await g.load()
    const tasks = g.entityMap.value.get('Tasks')
    expect(tasks).toBeTruthy()
    expect(tasks!.columns.get('status')).toEqual(
      expect.objectContaining({ type: 'cds.String' }),
    )
  })

  it('sqlNames returns the runtime-physical names', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.sqlNames.value['Tasks']).toBe('COM_SAP_DEVELOPERS_IMS_TASKS')
  })

  it('joinableTo returns associations whose target entity is in the entityMap', async () => {
    const g = useEntityGraph()
    await g.load()
    const joins = g.joinableTo('TaskRecords')
    expect(joins.length).toBe(1)
    expect(joins[0].targetEntity).toBe('Users')
  })

  it('joinableTo returns empty array for entities with no associations', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.joinableTo('Tasks')).toEqual([])
  })

  it('sampleDistinctCached caches by (table, column) within session', async () => {
    const g = useEntityGraph()
    await g.load()
    const r1 = await g.sampleDistinctCached('Tasks', 'status')
    const r2 = await g.sampleDistinctCached('Tasks', 'status')
    expect(r1).toBe(r2)
    const { sampleDistinct } = await import('../../api/distinct')
    expect((sampleDistinct as any).mock.calls.length).toBe(1)
  })

  it('sampleDistinctCached makes separate calls for different columns', async () => {
    const g = useEntityGraph()
    await g.load()
    await g.sampleDistinctCached('Tasks', 'status')
    await g.sampleDistinctCached('Tasks', 'taskType')
    const { sampleDistinct } = await import('../../api/distinct')
    expect((sampleDistinct as any).mock.calls.length).toBe(2)
  })
})
