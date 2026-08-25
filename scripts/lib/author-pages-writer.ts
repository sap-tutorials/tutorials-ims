import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { hugoFrontmatterStringify as yamlStringify } from './hugo-yaml.js'
import { buildAuthorIndex, type AuthorTutorialRow, type AuthorIndex } from '../parsers/author-index'

/**
 * Write author artifacts from an ALREADY-BUILT index:
 *   - `dataFile`     — hugo/data/author_index.json, read by authors/single.html
 *   - `publishFile`  — (optional) a copy served as a static asset so a
 *     catalog-only rebuild can re-hydrate it from the deployed approuter
 *     (see scripts/seed-authors-from-deployed.ts — the /authors/* wipe fix).
 *   - per-login `<login>.md` stubs under `contentDir`, which make Hugo emit
 *     each /authors/{login}/ page. Advocate logins are skipped (their advocate
 *     profile alias owns that path). Stubs for logins no longer in the index
 *     are pruned.
 *
 * Split out from writeAuthorPages so both the full-build path (which builds the
 * index from freshly-fetched rows) and the catalog-only re-hydration path (which
 * recovers a prebuilt index from the deployed site) share one emitter.
 */
export function writeAuthorPagesFromIndex(opts: {
  index: AuthorIndex
  dataFile: string
  contentDir: string
  publishFile?: string
}): { pagesWritten: number } {
  const { index, dataFile, contentDir, publishFile } = opts
  const json = JSON.stringify(index, null, 2)

  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileSync(dataFile, json, 'utf-8')

  if (publishFile) {
    mkdirSync(dirname(publishFile), { recursive: true })
    writeFileSync(publishFile, json, 'utf-8')
  }

  mkdirSync(contentDir, { recursive: true })
  const wanted = new Set<string>()
  let pagesWritten = 0
  for (const login of Object.keys(index)) {
    if (index[login].advocateSlug) continue // advocate alias owns /authors/{login}/
    wanted.add(login)
    const fm = yamlStringify({
      title: `Tutorials by ${index[login].displayName}`,
      type: 'authors',
      layout: 'single',
      login,
      slug: login,
    })
    writeFileSync(join(contentDir, `${login}.md`), `---\n${fm}---\n`, 'utf-8')
    pagesWritten++
  }

  if (existsSync(contentDir)) {
    for (const entry of readdirSync(contentDir)) {
      if (entry === '_index.md' || !entry.endsWith('.md')) continue
      const login = entry.replace(/\.md$/, '')
      if (!wanted.has(login)) unlinkSync(join(contentDir, entry))
    }
  }
  return { pagesWritten }
}

export function writeAuthorPages(opts: {
  rows: AuthorTutorialRow[]
  advocates: Map<string, string>
  dataFile: string
  contentDir: string
  /** Optional static-asset copy of author_index.json (served for re-hydration). */
  publishFile?: string
  /** ACTIVE/published catalog slug set (lowercase). Rows whose slug isn't in it
   *  are excluded (unpublished/deleted). Fail-open when empty/undefined. */
  activeSlugs?: Set<string>
}): { pagesWritten: number } {
  const { rows, advocates, dataFile, contentDir, publishFile, activeSlugs } = opts
  const index = buildAuthorIndex(rows, advocates, activeSlugs)
  return writeAuthorPagesFromIndex({ index, dataFile, contentDir, publishFile })
}
