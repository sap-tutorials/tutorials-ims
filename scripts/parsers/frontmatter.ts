import matter from 'gray-matter'
import type { TutorialFrontmatter } from './types.js'

export interface FrontmatterResult {
  frontmatter: TutorialFrontmatter
  title: string
  description: string
  youWillLearn: string[]
  prerequisites: string
  level: string
  body: string
}

/**
 * Clean raw markdown before YAML frontmatter parsing:
 * - Strip git merge conflict markers (keeping "ours" side)
 * - Fix missing space after YAML keys (e.g. `tags:[` → `tags: [`)
 * - Remove double commas in tag arrays
 */
function sanitizeRawMarkdown(md: string): string {
  // Strip git merge conflict markers — keep the HEAD (ours) version
  md = md.replace(
    /^<<<<<<< .+\n([\s\S]*?)^=======\n[\s\S]*?^>>>>>>> .+\n/gm,
    '$1'
  )
  // Fix missing space after colon in YAML keys (e.g. `tags:[` → `tags: [`)
  md = md.replace(/^(\w+):(\[)/gm, '$1: $2')
  // Remove double commas in YAML arrays
  md = md.replace(/,,/g, ',')
  return md
}

/**
 * Coerce frontmatter `time` to a number. Source tutorials are inconsistent:
 * authors write `time: 15`, `time: "30 mins"`, `time: 120 minutes`, etc.
 * Without this, string values flow through `reduce((s,t) => s+t.time, 0)`
 * and concatenate ("030 mins45") or produce NaN on the navigator cards.
 */
function coerceTime(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const match = raw.match(/-?\d+/)
    if (match) {
      const n = parseInt(match[0], 10)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

export function extractFrontmatter(md: string): FrontmatterResult {
  const { data, content } = matter(sanitizeRawMarkdown(md))
  const fm = data as TutorialFrontmatter
  const coerced = coerceTime(fm.time)
  if (coerced !== undefined) fm.time = coerced
  else delete (fm as { time?: number }).time

  const titleMatch = content.match(/^# (.+)$/m)
  const title = fm.title ?? titleMatch?.[1]?.trim() ?? ''

  const descMatch = content.match(/<!--\s*description\s*-->\s*(.+)$/m)
  const description = fm.description ?? descMatch?.[1]?.trim() ?? ''

  const youWillLearn = extractBulletList(content, 'You will learn')
  const prerequisites = extractSection(content, 'Prerequisites')
  const level = normalizeLevel(fm.tags ?? [])

  return { frontmatter: fm, title, description, youWillLearn, prerequisites, level, body: content }
}

function extractBulletList(content: string, heading: string): string[] {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n### |$)`)
  const match = content.match(pattern)
  if (!match) return []
  return match[1]
    .split('\n')
    .filter(line => line.match(/^\s*-\s+/))
    .map(line => line.replace(/^\s*-\s+/, '').trim())
}

function extractSection(content: string, heading: string): string {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n### |$)`)
  const match = content.match(pattern)
  return match?.[1]?.trim() ?? ''
}

function normalizeLevel(tags: string[]): string {
  for (const tag of tags) {
    if (tag.includes('tutorial>beginner')) return 'beginner'
    if (tag.includes('tutorial>intermediate')) return 'intermediate'
    if (tag.includes('tutorial>advanced')) return 'advanced'
  }
  return 'beginner'
}
