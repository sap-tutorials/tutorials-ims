export interface ExposedColumn { name: string; type: string; nullable: boolean; length: number | null }
export interface ExposedEntity { name: string; label: string; description: string; columns: ExposedColumn[] }

let cache: Promise<ExposedEntity[]> | null = null

export function getCachedEntityMetadata(): Promise<ExposedEntity[]> {
  if (!cache) {
    cache = fetch('/admin/analytics/listExposedEntities()', {
      headers: { Accept: 'application/json' },
    }).then(async (r) => {
      if (!r.ok) {
        cache = null
        throw new Error(`listExposedEntities failed: ${r.status}`)
      }
      const json = await r.json()
      return json.value as ExposedEntity[]
    })
  }
  return cache
}

export function clearEntityCache(): void { cache = null }
