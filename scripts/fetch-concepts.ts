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
  const refs = (arr: { slug: string; title?: string; name?: string }[]) =>
    arr.length === 0
      ? '[]'
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
