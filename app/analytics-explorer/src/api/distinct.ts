import { useAuth } from '../composables/useAuth'

export interface DistinctResult {
  values: string[]
  truncated: boolean
}

export async function sampleDistinct(
  table: string,
  column: string,
  limit = 100,
): Promise<DistinctResult> {
  // OData unbound function call: <servicePath>sampleDistinct(table='X',column='Y',limit=100)
  // Admins hit /admin/analytics/, authors hit /author/.
  const { servicePath } = useAuth()
  const params = [
    `table='${encodeURIComponent(table)}'`,
    `column='${encodeURIComponent(column)}'`,
    `limit=${limit}`,
  ].join(',')
  const url = `${servicePath.value}sampleDistinct(${params})`
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`sampleDistinct ${r.status}: ${text}`)
  }
  return await r.json()
}
