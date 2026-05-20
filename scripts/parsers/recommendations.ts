import type { TutorialNavEntry } from './types'

export interface RecommendationOptions {
  topN?: number
  primaryTagBonus?: number
}

export function computeRecommendations(
  entries: TutorialNavEntry[],
  options: RecommendationOptions = {},
): Map<string, string[]> {
  const topN = options.topN ?? 3
  const primaryTagBonus = options.primaryTagBonus ?? 10
  const result = new Map<string, string[]>()

  for (const target of entries) {
    const candidates: Array<{ slug: string; score: number; title: string }> = []
    const targetTags = new Set(target.displayTags)

    for (const candidate of entries) {
      if (candidate.slug === target.slug) continue
      if (target.missionId && candidate.missionId === target.missionId) continue

      let score = 0
      if (target.primaryTag && candidate.primaryTag === target.primaryTag) {
        score += primaryTagBonus
      }
      for (const tag of candidate.displayTags) {
        if (targetTags.has(tag)) score += 1
      }

      if (score > 0) {
        candidates.push({ slug: candidate.slug, score, title: candidate.title })
      }
    }

    candidates.sort((a, b) =>
      b.score - a.score || a.title.localeCompare(b.title)
    )

    result.set(target.slug, candidates.slice(0, topN).map(c => c.slug))
  }

  return result
}
