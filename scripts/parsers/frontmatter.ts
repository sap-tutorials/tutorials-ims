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

export function extractFrontmatter(md: string): FrontmatterResult {
  const { data, content } = matter(sanitizeRawMarkdown(md))
  const fm = data as TutorialFrontmatter

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
