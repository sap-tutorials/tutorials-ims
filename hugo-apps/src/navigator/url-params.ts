// hugo-apps/src/navigator/url-params.ts
//
// Issue #161 — URL → filter parsers consumed by TutorialNavigator.vue's
// onMounted block. Kept pure (no Vue refs, no DOM access) so they can
// be unit-tested without mounting the navigator component. See
// url-params.test.ts for the contract.

const VALID_LEVELS = new Set(['beginner', 'intermediate', 'advanced'])

/**
 * Pull every `?tag=…` value out of a URLSearchParams. Empty strings are
 * dropped; duplicates are preserved (the caller is responsible for any
 * dedupe — TutorialNavigator pushes only when not already present).
 *
 * URL decoding is handled by URLSearchParams itself, so a slug like
 * `topic>abap-development` round-trips through `?tag=topic%3Eabap-development`
 * without manual encoding.
 */
export function parseTagParams(searchParams: URLSearchParams): string[] {
  return searchParams.getAll('tag').filter((s) => s.length > 0)
}

/**
 * Pull every `?level=…` value, lowercase, and reject anything outside the
 * canonical experience set. Unknown values (legacy AEM strings, typos)
 * are dropped silently rather than producing a bogus filter chip.
 */
export function parseLevelParams(searchParams: URLSearchParams): string[] {
  return searchParams
    .getAll('level')
    .map((s) => s.toLowerCase())
    .filter((s) => VALID_LEVELS.has(s))
}

/**
 * Issue #1804 — split experience-level slugs out of a product-slug list.
 *
 * `tutorial>beginner|intermediate|advanced` belong to the Experience facet,
 * not Software Product. A level slug left in `filters.products` OR-matches
 * every same-level tutorial (the product filter is a `some()` over
 * `displayTagSlugs`), so the Software Product filter appears to do nothing —
 * the reported symptom. Such a slug can arrive via a `?tag=tutorial>beginner`
 * chip, a stale `?product=…,tutorial>beginner` URL, or poisoned localStorage.
 *
 * Other `tutorial>*` slugs (`tutorial>free-tier`, `tutorial>how-to`) are
 * legitimate Software Product facets and are preserved verbatim. Level values
 * are lowercased and deduped, matching `parseLevelParams`' canonical form.
 *
 * Pure: returns a new `{ products, levels }` pair, mutates nothing.
 */
export function extractExperienceLevels(
  products: string[],
): { products: string[]; levels: string[] } {
  const keptProducts: string[] = []
  const levels: string[] = []
  for (const slug of products) {
    const match = /^tutorial>(.+)$/.exec(slug)
    const level = match ? match[1].toLowerCase() : ''
    if (match && VALID_LEVELS.has(level)) {
      if (!levels.includes(level)) levels.push(level)
    } else {
      keptProducts.push(slug)
    }
  }
  return { products: keptProducts, levels }
}
