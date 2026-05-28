// Detect license-gated tutorials and filter the redundant text chip.
// The "License" string is what `humanizeTag('tutorial>license')` produces
// in scripts/parsers/render-frontmatter.ts; treat that as the contract.
export const LICENSE_TAG = 'License'

export function requiresLicense(displayTags: readonly string[]): boolean {
  return displayTags.includes(LICENSE_TAG)
}

export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter(t => t !== LICENSE_TAG)
}
