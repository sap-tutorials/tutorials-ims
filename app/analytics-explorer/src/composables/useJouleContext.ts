import { ref, type Ref } from 'vue'
import { useQuerySpec } from './useQuerySpec'
import { getCachedEntityMetadata } from '../api/entities'
import { redactPii } from '../lib/redactPii'

export interface LastResultInput {
  entityName: string
  columns: string[]
  rows: any[][]
  rowCount: number
  truncated: boolean
}

let _singleton: ReturnType<typeof create> | null = null

function create() {
  const lastResult: Ref<LastResultInput | null> = ref(null)

  function setLastResult(r: LastResultInput | null) { lastResult.value = r }

  async function build() {
    const { spec } = useQuerySpec()
    const pc: any = {
      kind: 'admin',
      tool: 'analytics-builder',
      currentSpec: spec.value,
    }
    if (lastResult.value) {
      const entities = await getCachedEntityMetadata()
      const redacted = redactPii({
        entityName: lastResult.value.entityName,
        columns: lastResult.value.columns,
        rows: lastResult.value.rows,
      }, entities)
      pc.lastResult = {
        columns: redacted.columns,
        rows: redacted.rows,
        rowCount: lastResult.value.rowCount,
        truncated: lastResult.value.truncated || redacted.truncated,
        redactedColumns: redacted.redactedColumns,
      }
    }
    return pc
  }

  return { setLastResult, build, lastResult }
}

export function useJouleContext() {
  if (!_singleton) _singleton = create()
  return _singleton
}

export function _resetForTest() { _singleton = null }
