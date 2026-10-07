import type { DiscoveredTutorial } from '../parsers/github.js'

/** Drop tutorials whose lowercased slug is in `excluded` (#2585). Pure + testable. */
export function applyExclusion(tutorials: DiscoveredTutorial[], excluded: Set<string>): DiscoveredTutorial[] {
  if (!excluded.size) return tutorials
  return tutorials.filter(t => !excluded.has(t.slug.toLowerCase()))
}
