import matter from 'gray-matter'
import type { TutorialFrontmatter } from './types.js'
import { commentLineFlags } from './html-comment-lines.js'

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

  // Mask lines inside multi-line HTML comments so a commented-out
  // `## You will learn` / `## Prerequisites` is NOT lifted out as a real
  // section (and its closing `-->` never leaks into the field). Regexes below
  // run against the masked copy; line count/offsets are preserved so the
  // `\n## `/`\n### ` section-boundary lookaheads still align.
  const contentLines = content.split('\n')
  const commented = commentLineFlags(contentLines)
  const maskedContent = contentLines
    .map((line, i) => (commented[i] ? '' : line))
    .join('\n')

  const youWillLearn = extractBulletList(maskedContent, 'You will learn')
  const prerequisites = extractSection(maskedContent, 'Prerequisites')
  const level = normalizeLevel(fm.tags ?? [])

  return { frontmatter: fm, title, description, youWillLearn, prerequisites, level, body: content }
}

function extractBulletList(content: string, heading: string): string[] {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n### |$)`)
  const match = content.match(pattern)
  if (!match) return []
  // Group each `- ` bullet with any wrapped continuation lines that follow it.
  // Previously non-bullet lines were filtered out entirely, so a wrapped
  // multi-line bullet lost every line after the first (issue #1388). We now
  // fold continuation text into the preceding bullet. Lines before the first
  // bullet (stray prose) are still dropped — youWillLearn is a bullet list by
  // contract and its render path (check-icon <li> per entry) assumes so.
  const items: string[] = []
  for (const rawLine of match[1].split('\n')) {
    const bulletMatch = rawLine.match(/^\s*-\s+(.*)$/)
    if (bulletMatch) {
      items.push(bulletMatch[1].trim())
    } else if (items.length > 0 && rawLine.trim().length > 0 && !/^\s*-{3,}\s*$/.test(rawLine)) {
      // Continuation of the current bullet's wrapped text. Skip thematic-break
      // (`---`) lines so a trailing horizontal rule isn't glued onto the last
      // bullet (same hazard as the prereq section, issue #163).
      items[items.length - 1] = `${items[items.length - 1]} ${rawLine.trim()}`.trim()
    }
  }
  return items
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
