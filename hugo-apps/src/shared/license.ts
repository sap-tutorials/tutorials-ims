// Detect license-gated tutorials. The join key is the raw AEM slug
// `tutorial>license` carried in displayTagSlugs[]. Comparing against the
// human label `displayTags` would false-positive on any custom tag whose
// label happens to be "License".
export const LICENSE_SLUG = 'tutorial>license'

interface TaggedItem {
  displayTags: readonly string[]
  displayTagSlugs: readonly string[]
}

export function requiresLicense(item: TaggedItem): boolean {
  return item.displayTagSlugs.includes(LICENSE_SLUG)
}

/**
 * Returns the labels the user should see, excluding the license chip.
 * Pairs displayTags[i] with displayTagSlugs[i] — the two arrays are
 * always emitted in matching order by render-frontmatter.ts.
 */
export function visibleTags(item: TaggedItem): string[] {
  const out: string[] = []
  for (let i = 0; i < item.displayTags.length; i++) {
    if (item.displayTagSlugs[i] !== LICENSE_SLUG) out.push(item.displayTags[i])
  }
  return out
}
