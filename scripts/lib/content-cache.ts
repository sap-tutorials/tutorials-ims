// Generated-content cache helpers (Workstream C of slug-targeted-delta-rebuild).
//
// On a slug-targeted rebuild, fetch-tutorials regenerates the generated Hugo
// content (`hugo/content/tutorials/<slug>.md`) for ALL ~1400 tutorials from the
// markdown cache, even though only the target slug changed — the bulk of the
// ~56s "Fetch tutorials" cost (see the slug-targeted-delta-rebuild design, R1).
//
// The fast path reuses the previously-generated `.md` for non-target slugs
// instead of recomposing them. Correctness hinges on the fact that a non-target
// tutorial's generated output depends ONLY on: (a) the parser/generator source,
// and (b) the global CAP `/build` feeds (catalog / co-completions / tag-labels),
// which drive the cross-tutorial frontmatter patch (prev/next/mission/
// recommendations/displayTags). The target slug is ALWAYS rebuilt, so its own
// source is never part of the reuse decision.
//
// Two gates protect the reuse, and BOTH must hold or we full-regenerate:
//   1. Parser-source hash — enforced by the CI `actions/cache` KEY (hashFiles of
//      scripts/parsers/** + fetch-tutorials.ts). A parser change misses the
//      cache entirely, so nothing is restored to reuse.
//   2. Feed fingerprint — enforced HERE at runtime. actions/cache keys can't
//      hash the `/build` feeds (they're fetched after cache restore), so the
//      sidecar records a fingerprint of the feeds at write time; a mismatch on
//      the next run means the catalog/nav/tags changed and every tutorial's
//      frontmatter must be re-patched → full regen.
//
// Everything here is pure + fail-open: any parse/IO error → treat as a cache
// miss (eligible=false) and the caller full-regenerates.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const SIDECAR_VERSION = 1

export interface ContentCacheSidecar {
  version: number
  // sha256 of the global feed payloads at the time the cache was written.
  feedFingerprint: string
  // Per-slug nav entries (the same objects written to _nav.json) so non-target
  // slugs can contribute to nav / browse.json without being recomposed.
  navEntries: Record<string, unknown>[]
  // Per-slug author rows (one per tutorial) so reused slugs still contribute to
  // author pages / "more from this author" without recomposition.
  authorRows?: Record<string, unknown>[]
}

export interface FeedPayloads {
  catalog: unknown
  tagLabels: unknown
  // Optional: co-completions drive recommendations, which are empty on warm-CAP-
  // cache runs and client-hydrated at render time, so they are excluded from the
  // fingerprint by callers on the fast path. Kept optional for completeness/tests.
  coCompletions?: unknown
}

// Stable JSON stringify (sorted keys) so semantically-identical feeds always
// hash identically regardless of key order / whitespace from the source.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

// Deterministic fingerprint of the three global feeds. Any change to catalog
// (mission/group membership, ordering), co-completions (recommendations), or
// tag-labels (displayTags) flips the fingerprint → forces full regen.
export function computeFeedFingerprint(feeds: FeedPayloads): string {
  const h = createHash('sha256')
  h.update('catalog\0'); h.update(stableStringify(feeds.catalog))
  h.update('\0coCompletions\0'); h.update(stableStringify(feeds.coCompletions ?? null))
  h.update('\0tagLabels\0'); h.update(stableStringify(feeds.tagLabels))
  return h.digest('hex')
}

// Read the sidecar; returns null on any fault (missing, malformed, wrong
// version) so the caller fail-opens to full regeneration.
export function readSidecar(path: string): ContentCacheSidecar | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ContentCacheSidecar
    if (!parsed || parsed.version !== SIDECAR_VERSION) return null
    if (typeof parsed.feedFingerprint !== 'string' || !Array.isArray(parsed.navEntries)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeSidecar(path: string, sidecar: ContentCacheSidecar): void {
  writeFileSync(path, JSON.stringify(sidecar), 'utf-8')
}

export interface FastPathDecision {
  eligible: boolean
  reason: string
}

// Decide whether the slug-targeted fast path may reuse cached generated content.
// Eligible only when: the flag is on, this is a slug-targeted run, a valid
// sidecar was restored, and its feed fingerprint matches the current feeds.
export function decideFastPath(args: {
  flagEnabled: boolean
  isSlugTargeted: boolean
  sidecar: ContentCacheSidecar | null
  currentFingerprint: string
}): FastPathDecision {
  if (!args.flagEnabled) return { eligible: false, reason: 'flag off (CONTENT_CACHE_FAST_PATH)' }
  if (!args.isSlugTargeted) return { eligible: false, reason: 'not a slug-targeted run' }
  if (!args.sidecar) return { eligible: false, reason: 'no valid sidecar restored (cache miss / first run)' }
  if (args.sidecar.feedFingerprint !== args.currentFingerprint) {
    return { eligible: false, reason: 'feed fingerprint changed (catalog/co-completions/tag-labels differ) — full regen' }
  }
  return { eligible: true, reason: 'parser source (cache key) + feeds unchanged — reusing cached non-target content' }
}

// Build a slug -> navEntry lookup from the sidecar for reconstructing non-target
// nav data without recomposing. Slugs are compared lowercase (canonical).
export function navEntriesBySlug(sidecar: ContentCacheSidecar): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const entry of sidecar.navEntries) {
    const slug = typeof entry?.slug === 'string' ? entry.slug.toLowerCase() : null
    if (slug) map.set(slug, entry)
  }
  return map
}
