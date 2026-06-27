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

interface ConceptPayload {
  slug: string
  name: string
  description: string
  teaches: { slug: string; title: string }[]
  requires: { slug: string; name: string }[]
  requiredBy: { slug: string; name: string }[]
  relatedTo: { slug: string; name: string }[]
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

function frontmatter(c: ConceptPayload): string {
  const refs = (arr: { slug: string; title?: string; name?: string }[]) =>
    arr.length === 0
      ? '[]'
      : '\n' + arr.map(r => `  - slug: ${yamlEscape(r.slug)}\n    title: ${yamlEscape(r.title ?? r.name ?? '')}`).join('\n')

  // NOTE: deliberately no `type:` field — Hugo's type-based lookup is singular
  // ("type: concept" → layouts/concept/), but our template lives at
  // layouts/concepts/ (matching the section). Section-based lookup is what we
  // want; setting `type` here would silently bypass it.
  return [
    '---',
    `slug: ${yamlEscape(c.slug)}`,
    `name: ${yamlEscape(c.name)}`,
    `description: ${yamlEscape(c.description)}`,
    `teaches:${refs(c.teaches)}`,
    `requires:${refs(c.requires)}`,
    `requiredBy:${refs(c.requiredBy)}`,
    `relatedTo:${refs(c.relatedTo)}`,
    '---',
    ''
  ].join('\n')
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
    `---\ntitle: Concepts\nlayout: concepts-index\n---\n`, 'utf8')

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
