export interface ExposedColumn { name: string; type: string; nullable: boolean; length: number | null; pii?: boolean }
export interface ExposedEntity { name: string; sqlName?: string; label: string; description: string; columns: ExposedColumn[] }

let cache: Promise<ExposedEntity[]> | null = null

export function getCachedEntityMetadata(): Promise<ExposedEntity[]> {
  if (!cache) {
    cache = fetch('/admin/analytics/listExposedEntities()', {
      headers: { Accept: 'application/json' },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`listExposedEntities failed: ${r.status}`)
      const json = await r.json()
      return json.value as ExposedEntity[]
    }).catch((e) => {
      cache = null
      throw e
    })
  }
  return cache
}

export function clearEntityCache(): void { cache = null }
