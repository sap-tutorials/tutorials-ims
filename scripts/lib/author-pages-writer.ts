import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { buildAuthorIndex, type AuthorTutorialRow } from '../parsers/author-index'

export function writeAuthorPages(opts: {
  rows: AuthorTutorialRow[]
  advocates: Map<string, string>
  dataFile: string
  contentDir: string
}): { pagesWritten: number } {
  const { rows, advocates, dataFile, contentDir } = opts
  const index = buildAuthorIndex(rows, advocates)

  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(index, null, 2), 'utf-8')

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
