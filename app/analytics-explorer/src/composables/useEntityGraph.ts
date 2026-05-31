import { ref, computed } from 'vue'
import { getCachedEntityMetadata } from '../api/entities'
import { sampleDistinct as apiSampleDistinct } from '../api/distinct'
import type { DistinctResult } from '../api/distinct'

interface ColumnMeta {
  type: string
  hanaType: string
  nullable: boolean
  length: number | null
  filterMode: 'enum' | 'free' | 'date' | 'numeric-range'
  filterSample: boolean
  pii: boolean
}

interface AssociationMeta {
  name: string
  targetEntity: string
  cardinality: 'to-one' | 'to-many'
  onLocal: string[]
  onTarget: string[]
}

interface EntityMeta {
  name: string
  label: string
  sqlName: string
  columns: Map<string, ColumnMeta>
  associations: AssociationMeta[]
}

const _entities = ref<any[]>([])
const _entityMap = ref<Map<string, EntityMeta>>(new Map())
const _sqlNames = ref<Record<string, string>>({})
const _loaded = ref(false)
const _distinctCache = new Map<string, Promise<DistinctResult>>()

export function _resetForTest() {
  _entities.value = []
  _entityMap.value = new Map()
  _sqlNames.value = {}
  _loaded.value = false
  _distinctCache.clear()
}

export function useEntityGraph() {
  async function load() {
    if (_loaded.value) return
    const list = await getCachedEntityMetadata()
    _entities.value = list as any[]
    const map = new Map<string, EntityMeta>()
    const names: Record<string, string> = {}
    for (const e of list as any[]) {
      const cols = new Map<string, ColumnMeta>()
      for (const c of e.columns) {
        cols.set(c.name, {
          type: c.type,
          hanaType: c.hanaType,
          nullable: c.nullable,
          length: c.length,
          filterMode: c.filterMode,
          filterSample: c.filterSample,
          pii: c.pii,
        })
      }
      map.set(e.name, {
        name: e.name,
        label: e.label,
        sqlName: e.sqlName,
        columns: cols,
        associations: (e.associations || []) as AssociationMeta[],
      })
      names[e.name] = e.sqlName
    }
    _entityMap.value = map
    _sqlNames.value = names
    _loaded.value = true
  }

  function joinableTo(entityName: string): AssociationMeta[] {
    const meta = _entityMap.value.get(entityName)
    if (!meta) return []
    return meta.associations.filter(a => _entityMap.value.has(a.targetEntity))
  }

  function sampleDistinctCached(table: string, column: string): Promise<DistinctResult> {
    const key = `${table}.${column}`
    let p = _distinctCache.get(key)
    if (!p) {
      p = apiSampleDistinct(table, column).catch(err => {
        // Drop failed promises from the cache so the user can retry.
        _distinctCache.delete(key)
        throw err
      })
      _distinctCache.set(key, p)
    }
    return p
  }

  return {
    entities: _entities,
    entityMap: _entityMap,
    sqlNames: _sqlNames,
    loaded: computed(() => _loaded.value),
    load,
    joinableTo,
    sampleDistinctCached,
  }
}
