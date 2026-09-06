import { useAuth } from '../composables/useAuth'

export interface DistributionRow {
  tutorialSlug: string
  dimension: string
  score: number
  responseCount: number
}

export interface ParentRow {
  tutorialSlug: string
  tutorialTitle: string
  missionTitle: string | null
  groupTitle: string | null
}

export interface CommentRow {
  submittedAt: string
  tutorialSlug: string
  comment: string
}

// Display order for the 7 histograms (6 ratings + NPS).
export const SURVEY_DIMENSIONS = [
  'structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'
] as const

export interface DistributionBucket { score: number; count: number; pct: number }

// Pure: sum counts per (dimension, score) across all passed rows, then compute
// pct within each dimension. No network — unit-testable in isolation.
export function aggregateDistribution(
  rows: DistributionRow[]
): Record<string, DistributionBucket[]> {
  const byDim: Record<string, Map<number, number>> = {}
  for (const r of rows) {
    if (!byDim[r.dimension]) byDim[r.dimension] = new Map()
    const m = byDim[r.dimension]
    m.set(r.score, (m.get(r.score) ?? 0) + r.responseCount)
  }
  const out: Record<string, DistributionBucket[]> = {}
  for (const [dim, m] of Object.entries(byDim)) {
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    out[dim] = [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([score, count]) => ({ score, count, pct: total ? (count * 100) / total : 0 }))
  }
  return out
}

function odataInFilter(field: string, values: string[]): string {
  // Builds "field eq 'a' or field eq 'b'" (slugs are lowercase canonical, no quotes inside).
  return values.map(v => `${field} eq '${v.replace(/'/g, "''")}'`).join(' or ')
}

async function readValue<T>(path: string): Promise<T[]> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`OData ${r.status} for ${path}`)
  const json = await r.json()
  return (json.value ?? []) as T[]
}

export async function fetchTutorialParents(): Promise<ParentRow[]> {
  const { servicePath } = useAuth()
  const url = `${servicePath.value}AuthorTutorialParents`
    + `?$select=tutorialSlug,tutorialTitle,missionTitle,groupTitle&$top=5000`
  return readValue<ParentRow>(url)
}

export async function fetchSurveyDistribution(slugs: string[]): Promise<DistributionRow[]> {
  if (slugs.length === 0) return []
  const { servicePath } = useAuth()
  const filter = encodeURIComponent(odataInFilter('tutorialSlug', slugs))
  const url = `${servicePath.value}AuthorSurveyDistribution`
    + `?$select=tutorialSlug,dimension,score,responseCount&$filter=${filter}&$top=5000`
  return readValue<DistributionRow>(url)
}

export async function fetchSurveyComments(slugs: string[], top = 200): Promise<CommentRow[]> {
  if (slugs.length === 0) return []
  const { servicePath } = useAuth()
  const filter = encodeURIComponent(`(${odataInFilter('tutorialSlug', slugs)}) and comment ne null`)
  const url = `${servicePath.value}TutorialFeedback`
    + `?$select=submittedAt,tutorialSlug,comment&$filter=${filter}`
    + `&$orderby=submittedAt desc&$top=${top}`
  return readValue<CommentRow>(url)
}
