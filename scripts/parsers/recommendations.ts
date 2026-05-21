import type { TutorialNavEntry } from './types.js'

export interface RecommendationOptions {
  topN?: number
  primaryTagBonus?: number
  coCompletions?: Map<string, Map<string, number>>
  coWeight?: number   // default 0.6
  tagWeight?: number  // default 0.4
}

export function computeRecommendations(
  entries: TutorialNavEntry[],
  options: RecommendationOptions = {},
): Map<string, string[]> {
  const topN = options.topN ?? 3
  const primaryTagBonus = options.primaryTagBonus ?? 10
  const coWeight = options.coWeight ?? 0.6
  const tagWeight = options.tagWeight ?? 0.4
  const coMap = options.coCompletions

  // Pure tag-overlap scorer; reused by both passes and by the v1 fallback path.
  function tagScoreFor(target: TutorialNavEntry, candidate: TutorialNavEntry): number {
    if (candidate.slug === target.slug) return 0
    if (target.missionId && candidate.missionId === target.missionId) return 0
    let score = 0
    if (target.primaryTag && candidate.primaryTag === target.primaryTag) {
      score += primaryTagBonus
    }
    const targetTags = new Set(target.displayTags)
    for (const tag of candidate.displayTags) {
      if (targetTags.has(tag)) score += 1
    }
    return score
  }

  // First pass — discover corpus-wide max tag score so per-pair normalization is
  // stable. Without this, an early candidate with a small score gets divided by a
  // small running max and is artificially inflated relative to later candidates.
  let maxTagScore = 1
  let maxCoScore = 1
  if (coMap) {
    for (const target of entries) {
      for (const candidate of entries) {
        const s = tagScoreFor(target, candidate)
        if (s > maxTagScore) maxTagScore = s
      }
    }
    for (const inner of coMap.values()) {
      for (const v of inner.values()) if (v > maxCoScore) maxCoScore = v
    }
  }

  const result = new Map<string, string[]>()

  // Second pass — actually score and rank.
  for (const target of entries) {
    const candidates: Array<{ slug: string; score: number; title: string }> = []
    const targetCo = coMap?.get(target.slug)

    for (const candidate of entries) {
      if (candidate.slug === target.slug) continue
      if (target.missionId && candidate.missionId === target.missionId) continue

      const tagScore = tagScoreFor(target, candidate)
      const coScore = targetCo?.get(candidate.slug) ?? 0

      let blended: number
      if (coMap && coMap.size > 0) {
        const tagNorm = tagScore / maxTagScore
        const coNorm = coScore / maxCoScore
        blended = coWeight * coNorm + tagWeight * tagNorm
      } else {
        blended = tagScore
      }

      if (blended > 0) {
        candidates.push({ slug: candidate.slug, score: blended, title: candidate.title })
      }
    }

    candidates.sort((a, b) =>
      b.score - a.score || a.title.localeCompare(b.title)
    )

    result.set(target.slug, candidates.slice(0, topN).map(c => c.slug))
  }

  return result
}
