import { ref } from 'vue'
import { getCachedEntityMetadata } from '../api/entities'
import { cdsTypeToHanaType } from '../api/cds-types'
import { buildApplyUrl, type ChartConfigInput } from '../api/odata'

export interface ColumnMetadata {
  column: string
  dataType: string
  nullable: boolean
  length: number | null
}

export function useDataSource() {
  const columns = ref<ColumnMetadata[]>([])
  const rowCount = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadMetadata(entityName: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const meta = await getCachedEntityMetadata()
      const entry = meta.find(e => e.name === entityName)
      if (!entry) throw new Error(`Unknown entity: ${entityName}`)
      columns.value = entry.columns.map(c => ({
        column: c.name,
        dataType: cdsTypeToHanaType(c.type),
        nullable: c.nullable,
        length: c.length,
      }))
      rowCount.value = null
    } catch (e: any) {
      error.value = e.message
      throw e
    } finally {
      loading.value = false
    }
  }

  async function fetchAggregated(config: ChartConfigInput) {
    const url = buildApplyUrl(config)
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`OData ${r.status}`)
    const json = await r.json()
    const rows = json.value || []
    const cols = [
      ...config.dimensions.map(d => d.column),
      ...config.measures.map(m => m.alias),
    ]
    return { columns: cols, data: rows.map((row: any) => cols.map(c => row[c])) }
  }

  function clear() {
    columns.value = []
    rowCount.value = null
    error.value = null
  }

  return { columns, rowCount, loading, error, loadMetadata, fetchAggregated, clear }
}
