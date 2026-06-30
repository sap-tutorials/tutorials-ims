#!/usr/bin/env tsx
// Build-time fetcher for /concepts/<slug>/ Hugo pages.
//
// Calls /build/concepts (CAP) and emits one hugo/content/concepts/<slug>.md
// per publishable concept. Idempotent: deletes the output directory first.
//
// Sibling of scripts/fetch-tutorials.ts. CAP_BASE_URL env var picks the
// target (defaults to http://localhost:4004 for local dev).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { categoryLabel } from '../srv/lib/discovery-mission-categories.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'hugo', 'content', 'concepts')

const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004'

export interface ConceptPayload {
  slug: string
  name: string
  description: string
  teaches: { slug: string; title: string }[]
  requires: { slug: string; name: string }[]
  requiredBy: { slug: string; name: string }[]
  relatedTo: { slug: string; name: string }[]
  // Phase 4.1 (#447): learning journeys covering this concept. Empty until the
  // weekly fetch-learning-journeys cron has populated LearningJourneyConceptLinks.
  learningJourneys?: Array<{
    slug: string
    title: string
    url: string
    level?: string
    durationHours?: number
  }>
  // Phase 4.2 (#447 §9): SAP Community blog posts discussing this concept.
  // Empty until the daily fetch-blog-posts cron has populated
  // BlogPostConceptLinks. Shape mirrors the per-concept array emitted by
  // srv/lib/published-concepts-query.js (Task 2's extension).
  blogPosts?: Array<{
    slug: string
    title: string
    url: string
    authorName: string
    postedAt: string    // ISO timestamp
  }>
  // Phase 4.3 (#447 §8): SAP Discovery Center missions teaching this concept.
  // Empty until the weekly fetch-discovery-missions cron has populated
  // DiscoveryMissionConceptLinks. Shape mirrors the per-concept array
  // emitted by srv/lib/published-concepts-query.js. The backend ships
  // `categorySlug` (raw short-code from the MCP); frontmatter() resolves
  // it to a user-facing English `categoryLabel` at emission time via the
  // shared srv/lib/discovery-mission-categories.js helper.
  discoveryMissions?: Array<{
    slug: string
    title: string
    url: string
    effortLevel?: number
    categorySlug?: string
  }>
  // Phase 4.4 (#447 §9): SAP Developers YouTube videos teaching this concept.
  // Empty until the daily fetch-videos cron has populated
  // VideoConceptLinks. Shape mirrors the per-concept array emitted by
  // srv/lib/published-concepts-query.js (Task 2's extension). Pass-through:
  // `thumbnailUrl` is already a CDN URL (i.ytimg.com); `channelTitle` +
  // `publishedAt` flow through unchanged. CSP `img-src` allows i.ytimg.com.
  videos?: Array<{
    slug: string
    title: string
    url: string
    thumbnailUrl?: string
    channelTitle?: string
    publishedAt?: string    // ISO timestamp
  }>
  // Phase 4.5 (#746 §5): api.sap.com authority documentation referencing this
  // concept. Empty until the monthly fetch-api-docs cron has populated
  // ApiDocConceptLinks. Shape mirrors the per-concept array emitted by
  // srv/lib/published-concepts-query.js. Pass-through: `category` and
  // `apiType` flow through verbatim (no helper transformation). The
  // `description` LOB column is deliberately NOT in the wire payload
  // (LOB-locator safety, see spec §3).
  apiDocs?: Array<{
    slug: string
    title: string
    url: string
    category?: string
    apiType?: string
  }>
  // Phase 4.6 (#747 §5): SAP-samples GitHub repositories embodying this
  // concept. Empty until the weekly fetch-samples-job has populated
  // SampleConceptLinks. Shape mirrors the per-concept array emitted by
  // srv/lib/published-concepts-query.js (Task 2's extension). Pass-through:
  // `language`, `stars`, `lastCommitAt` flow through verbatim. The
  // `description` LOB column is deliberately NOT in the wire payload
  // (LOB-locator safety, see spec §3).
  samples?: Array<{
    slug: string
    title: string
    url: string
    language?: string
    stars?: number
    lastCommitAt?: string    // ISO timestamp
  }>
}

interface BuildConceptsResponse {
  concepts: ConceptPayload[]
  generatedAt: string
}

export function yamlEscape(s: string): string {
  return `"${(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`
}

export function frontmatter(c: ConceptPayload): string {
  // Empty arrays emit ` []` (leading space). The caller concatenates as
  // `relatedTo:${refs(c.relatedTo)}`, so without the leading space the
  // result is `relatedTo:[]` (no space after colon) — invalid YAML, fails
  // Hugo's frontmatter parser. Surfaced when the first batch of published
  // concepts ran through rebuild-content.yml on 2026-06-30 (workflow run
  // 28445308441). Discovered because PR #802 newly invoked fetch-concepts
  // in CI; the bug had been latent in #685's emission code since no real
  // data had reached this code path until then.
  const refs = (arr: { slug: string; title?: string; name?: string }[]) =>
    arr.length === 0
      ? ' []'
      : '\n' + arr.map(r => `  - slug: ${yamlEscape(r.slug)}\n    title: ${yamlEscape(r.title ?? r.name ?? '')}`).join('\n')

  // Phase 4.1 (#447): emit `learningJourneys` only when non-empty. The Hugo
  // concept template at layouts/concepts/single.html guards on `{{ with
  // .Params.learningJourneys }}`, which is falsy for both missing and empty
  // arrays — but we omit the key entirely for cleaner generated frontmatter.
  // Shape matches /build/concepts payload: {slug,title,url,level,durationHours}.
  const journeys = (c.learningJourneys && c.learningJourneys.length > 0)
    ? (() => {
        const lines = ['learningJourneys:']
        for (const j of c.learningJourneys!) {
          lines.push(`  - slug: ${yamlEscape(j.slug)}`)
          lines.push(`    title: ${yamlEscape(j.title)}`)
          lines.push(`    url: ${yamlEscape(j.url)}`)
          if (j.level) lines.push(`    level: ${yamlEscape(j.level)}`)
          if (j.durationHours != null) lines.push(`    durationHours: ${j.durationHours}`)
        }
        return lines.join('\n')
      })()
    : null

  // Phase 4.2 (#447 §9): emit `blogPosts` only when non-empty. Same omit-when-
  // empty discipline as learningJourneys above — the Hugo `{{ with }}` guard
  // would already hide the section, but omitting the key keeps generated
  // frontmatter tidy.
  // Shape matches /build/concepts payload: {slug,title,url,authorName,postedAt}.
  // All five fields are required on the wire (Task 2 always populates them
  // from BlogPosts.{authorName,postedAt}); no `if` guards inside the loop.
  const blogPosts = (c.blogPosts && c.blogPosts.length > 0)
    ? (() => {
        const lines = ['blogPosts:']
        for (const b of c.blogPosts!) {
          lines.push(`  - slug: ${yamlEscape(b.slug)}`)
          lines.push(`    title: ${yamlEscape(b.title)}`)
          lines.push(`    url: ${yamlEscape(b.url)}`)
          lines.push(`    authorName: ${yamlEscape(b.authorName)}`)
          lines.push(`    postedAt: ${yamlEscape(b.postedAt)}`)
        }
        return lines.join('\n')
      })()
    : null

  // Phase 4.3 (#447 §8): emit `discoveryMissions` only when non-empty.
  // The backend ships a raw `categorySlug` short-code; we resolve it
  // to a user-facing English `categoryLabel` at emission time via the
  // shared srv/lib/discovery-mission-categories.js helper (known slugs
  // map to canonical English; unknown slugs fall back to title-case).
  // Per-field guards: `effortLevel` and `categorySlug` are both optional
  // on the wire, so the loop only emits those lines when present.
  const discoveryMissions = (c.discoveryMissions && c.discoveryMissions.length > 0)
    ? (() => {
        const lines = ['discoveryMissions:']
        for (const m of c.discoveryMissions!) {
          lines.push(`  - slug: ${yamlEscape(m.slug)}`)
          lines.push(`    title: ${yamlEscape(m.title)}`)
          lines.push(`    url: ${yamlEscape(m.url)}`)
          if (m.effortLevel != null) lines.push(`    effortLevel: ${m.effortLevel}`)
          if (m.categorySlug) {
            lines.push(`    categoryLabel: ${yamlEscape(categoryLabel(m.categorySlug))}`)
          }
        }
        return lines.join('\n')
      })()
    : null

  // Phase 4.4 (#447 §9): emit `videos` only when non-empty. Pass-through —
  // no helper transformation. `thumbnailUrl` is already a CDN URL from
  // i.ytimg.com (allowed by approuter CSP `img-src`); `channelTitle` and
  // `publishedAt` (ISO timestamp) flow through unchanged. Per-field guards
  // because all three are optional on the wire.
  const videos = (c.videos && c.videos.length > 0)
    ? (() => {
        const lines = ['videos:']
        for (const v of c.videos!) {
          lines.push(`  - slug: ${yamlEscape(v.slug)}`)
          lines.push(`    title: ${yamlEscape(v.title)}`)
          lines.push(`    url: ${yamlEscape(v.url)}`)
          if (v.thumbnailUrl) lines.push(`    thumbnailUrl: ${yamlEscape(v.thumbnailUrl)}`)
          if (v.channelTitle) lines.push(`    channelTitle: ${yamlEscape(v.channelTitle)}`)
          if (v.publishedAt) lines.push(`    publishedAt: ${yamlEscape(v.publishedAt)}`)
        }
        return lines.join('\n')
      })()
    : null

  // Phase 4.5 (#746 §5): emit `apiDocs` only when non-empty. Pass-through —
  // no helper transformation. `category` and `apiType` are optional on the
  // wire; per-field guards skip emission when absent. The Hugo template's
  // surrounding `{{ with .Params.apiDocs }}` hides the entire section when
  // the key is missing — omitting at the emitter keeps generated
  // frontmatter tidy. `description` is deliberately NOT in this shape (LOB
  // locator safety — see spec §3).
  const apiDocs = (c.apiDocs && c.apiDocs.length > 0)
    ? (() => {
        const lines = ['apiDocs:']
        for (const a of c.apiDocs!) {
          lines.push(`  - slug: ${yamlEscape(a.slug)}`)
          lines.push(`    title: ${yamlEscape(a.title)}`)
          lines.push(`    url: ${yamlEscape(a.url)}`)
          if (a.category) lines.push(`    category: ${yamlEscape(a.category)}`)
          if (a.apiType) lines.push(`    apiType: ${yamlEscape(a.apiType)}`)
        }
        return lines.join('\n')
      })()
    : null

  // Phase 4.6 (#747 §5): emit `samples` only when non-empty. Pass-through —
  // no helper transformation. `language`, `stars`, and `lastCommitAt` are
  // optional on the wire; per-field guards skip emission when absent. The
  // Hugo template's surrounding `{{ with .Params.samples }}` hides the
  // entire section when the key is missing — omitting at the emitter keeps
  // generated frontmatter tidy. `description` is deliberately NOT in this
  // shape (LOB locator safety — see spec §3). Note: `stars != null` (not
  // truthy) so `stars: 0` still emits the line — defensive against newly
  // forked repos.
  const samples = (c.samples && c.samples.length > 0)
    ? (() => {
        const lines = ['samples:']
        for (const s of c.samples!) {
          lines.push(`  - slug: ${yamlEscape(s.slug)}`)
          lines.push(`    title: ${yamlEscape(s.title)}`)
          lines.push(`    url: ${yamlEscape(s.url)}`)
          if (s.language) lines.push(`    language: ${yamlEscape(s.language)}`)
          if (s.stars != null) lines.push(`    stars: ${s.stars}`)
          if (s.lastCommitAt) lines.push(`    lastCommitAt: ${yamlEscape(s.lastCommitAt)}`)
        }
        return lines.join('\n')
      })()
    : null

  // NOTE: deliberately no `type:` field — Hugo's type-based lookup is singular
  // ("type: concept" → layouts/concept/), but our template lives at
  // layouts/concepts/ (matching the section). Section-based lookup is what we
  // want; setting `type` here would silently bypass it.
  const parts = [
    '---',
    `slug: ${yamlEscape(c.slug)}`,
    `name: ${yamlEscape(c.name)}`,
    `description: ${yamlEscape(c.description)}`,
    `teaches:${refs(c.teaches)}`,
    `requires:${refs(c.requires)}`,
    `requiredBy:${refs(c.requiredBy)}`,
    `relatedTo:${refs(c.relatedTo)}`,
  ]
  if (journeys) parts.push(journeys)
  if (blogPosts) parts.push(blogPosts)
  if (discoveryMissions) parts.push(discoveryMissions)
  if (videos) parts.push(videos)
  if (apiDocs) parts.push(apiDocs)
  if (samples) parts.push(samples)
  parts.push('---', '')
  return parts.join('\n')
}

async function main() {
  console.log(`[fetch-concepts] GET ${CAP_BASE_URL}/build/concepts`)
  const r = await fetch(`${CAP_BASE_URL}/build/concepts`)
  if (!r.ok) {
    throw new Error(`/build/concepts returned ${r.status}: ${await r.text().catch(() => '')}`)
  }
  const data = (await r.json()) as BuildConceptsResponse

  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })

  // Counter enhancement (X published of Y total) deferred until /build/concepts
  // exposes the total or a tech-user-authed graph probe is available. Out of
  // scope for #446.
  console.log(`[fetch-concepts] ${data.concepts.length} published concept(s) — writing pages`)

  for (const c of data.concepts) {
    const filename = `${c.slug.toLowerCase()}.md`
    await fs.writeFile(path.join(OUT_DIR, filename), frontmatter(c), 'utf8')
  }

  await fs.writeFile(path.join(OUT_DIR, '_index.md'),
    `---\ntitle: Concepts\n---\n`, 'utf8')

  console.log(`[fetch-concepts] wrote ${data.concepts.length} page(s) + _index.md to ${OUT_DIR}`)
}

// Only run main() when invoked as a CLI — not when imported by tests.
// Mirrors the pattern in scripts/lint-tutorial-markdown.ts.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
