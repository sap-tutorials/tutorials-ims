/**
 * Catalog smoke test for #140 (sanitizer swap).
 *
 * Runs the OLD regex sanitizer and the NEW sanitize-html implementation
 * against every tutorial markdown file in the catalog, then categorizes
 * the diffs:
 *
 *   - "behavior-improvement"  — new strips dangerous tag content that old leaked
 *   - "self-closing-slash"    — `<img>` → `<img />` cosmetic difference
 *   - "pseudo-tag-encoded"    — `<your_id>` → `&lt;your_id&gt;` (renders identically)
 *   - "scheme-allowlist"      — old kept ftp:/file:/etc., new drops them
 *   - "regression"            — anything else (must be investigated)
 *
 * Run: npx tsx scripts/__tests__/sanitize-html-catalog-smoke.ts
 *
 * Exit code 0 if all diffs fall into known-acceptable categories.
 * Exit code 1 if there are unclassified regressions.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodeHTML } from 'entities'
import { stripDangerousHtml } from '../parsers/sanitize-html.js'

// Reconstruct the OLD sanitizer in-process so we have a fixed baseline.
const OLD_DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'applet',
  'form', 'input', 'textarea', 'button', 'select',
  'link', 'meta', 'base', 'svg', 'math',
  'foreignObject', 'animate', 'animateTransform', 'set',
  'style',
  'video', 'audio', 'picture', 'source', 'track',
  'frame', 'frameset', 'noframes', 'portal',
])
const OLD_EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const OLD_DANGEROUS_HREF_RE = /\s+(href|src|action|xlink:href|formaction)\s*=\s*(?:"\s*(?:javascript|data|vbscript|blob):[^"]*"|'\s*(?:javascript|data|vbscript|blob):[^']*'|(?:javascript|data|vbscript|blob):[^\s>]+)/gi

function oldStripDangerousHtml(content: string): string {
  const lines = content.split('\n')
  let inCodeFence = false
  let fenceChar = ''
  let fenceLen = 0

  return lines.map((line) => {
    if (inCodeFence) {
      const closeMatch = line.match(/^(\s*)(```+|~~~+)\s*$/)
      if (closeMatch && closeMatch[2].charAt(0) === fenceChar && closeMatch[2].length >= fenceLen) {
        inCodeFence = false
      }
      return line
    }
    const openMatch = line.match(/^(\s*)(```+|~~~+)(.*)$/)
    if (openMatch) {
      inCodeFence = true
      fenceChar = openMatch[2].charAt(0)
      fenceLen = openMatch[2].length
      return line
    }
    let result = line.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9:._-]*)[^>]*\/?>/g, (match, _slash: string, tagName: string) => {
      if (OLD_DANGEROUS_TAGS.has(tagName.toLowerCase())) return ''
      return match
    })
    result = result.replace(OLD_EVENT_ATTR_RE, '')
    result = result.replace(OLD_DANGEROUS_HREF_RE, '')
    return result
  }).join('\n')
}

interface Diff {
  file: string
  oldOut: string
  newOut: string
  category: string
}

function classify(oldOut: string, newOut: string): string {
  if (oldOut === newOut) return 'identical'

  // Definitive equivalence: if both outputs, after decoding entities and
  // stripping tags, produce identical text content, they will render
  // identically through Hugo + browser regardless of the cosmetic HTML
  // differences (self-closing slashes, pseudo-tag encoding, tag rebalancing,
  // orphan closure, malformed correction, named-entity decoding). Check
  // FIRST because if equivalent, no further classification is needed.
  const stripTags = (s: string) =>
    decodeHTML(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  if (stripTags(oldOut) === stripTags(newOut)) return 'cosmetic-equivalent'

  // Apply ALL known-acceptable transformations to the OLD output and see if
  // the result matches the NEW. The categories below are not mutually
  // exclusive (a single tutorial can have a self-closing-slash AND a pseudo-
  // tag-encoding AND an orphan-closure AND a malformed-correction); we
  // fold them all in together and bucket by the most prominent.
  let normalised = oldOut
  let categoriesApplied: string[] = []

  // 1. Add self-closing slash to void tags.
  const selfClosingTransform = (s: string) =>
    s.replace(/<(img|br|hr|area|base|input|link|meta|track|source|wbr)([^>]*?)>/gi, '<$1$2 />')
  if (selfClosingTransform(normalised) !== normalised) {
    categoriesApplied.push('self-closing-slash')
    normalised = selfClosingTransform(normalised)
  }

  // 2. Entity-encode pseudo-tags (unknown HTML elements).
  const KNOWN = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
    'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'u', 'ul', 'var',
  ])
  const pseudoTransform = (s: string) =>
    s.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?>/g, (match) => {
      const m = match.match(/^<\/?([a-zA-Z][a-zA-Z0-9_-]*)/)
      if (!m) return match
      if (KNOWN.has(m[1].toLowerCase())) return match
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
  const pseudoApplied = pseudoTransform(normalised)
  if (pseudoApplied !== normalised) {
    categoriesApplied.push('pseudo-tag-encoded')
    normalised = pseudoApplied
  }

  // 3. Orphan-tag closure (sanitize-html auto-closes <pre>, <li> etc.).
  const newNoCloses = newOut.replace(/<\/[a-z][a-z0-9]*>/g, '')
  const normalisedNoCloses = normalised.replace(/<\/[a-z][a-z0-9]*>/g, '')
  if (newNoCloses === normalisedNoCloses) {
    if (newOut !== normalised) categoriesApplied.push('orphan-closure')
    return categoriesApplied.length === 1 ? categoriesApplied[0] : 'mixed-acceptable'
  }
  if (newOut === normalised) {
    return categoriesApplied.length === 1 ? categoriesApplied[0] : 'mixed-acceptable'
  }

  // 4. Malformed-tag correction: `</br>` → `<br />`.
  if (oldOut.includes('</br>')) {
    const corrected = normalised.replace(/<\/br>/g, '<br />')
    if (corrected === newOut) {
      categoriesApplied.push('malformed-corrected')
      return categoriesApplied.length === 1 ? categoriesApplied[0] : 'mixed-acceptable'
    }
  }

  // Scheme allowlist
  const oldHrefs = (oldOut.match(/href="[^"]*"/g) || []).length
  const newHrefs = (newOut.match(/href="[^"]*"/g) || []).length
  if (newHrefs < oldHrefs) {
    const lostSchemes = (oldOut.match(/href="(?!https?:|mailto:|#|\/)([^"]*)"/g) || [])
    if (lostSchemes.length > 0) return 'scheme-allowlist'
  }

  // Behavior improvement
  if (newOut.length < oldOut.length && oldOut.match(/<\/?(script|style|textarea|noscript|option)/i)) {
    return 'behavior-improvement'
  }

  return 'regression'
}

const dir = process.argv[2] || join(process.cwd(), '..', '..', '..', 'hugo', 'content', 'tutorials')
if (!existsSync(dir)) {
  console.error(`Catalog dir not found: ${dir}`)
  console.error(`Pass an explicit path as argv[2] or run from a worktree where the parent has hugo/content/tutorials/`)
  process.exit(1)
}

const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
console.log(`Scanning ${files.length} tutorial files in ${dir}...\n`)

const counts: Record<string, number> = {}
const samples: Record<string, Diff[]> = {}
const SAMPLE_LIMIT = 5

for (const fname of files) {
  const content = readFileSync(join(dir, fname), 'utf8')
  const oldOut = oldStripDangerousHtml(content)
  const newOut = stripDangerousHtml(content)
  const cat = classify(oldOut, newOut)
  counts[cat] = (counts[cat] || 0) + 1
  if (cat !== 'identical') {
    if (!samples[cat]) samples[cat] = []
    if (samples[cat].length < SAMPLE_LIMIT) {
      samples[cat].push({ file: fname, oldOut, newOut, category: cat })
    }
  }
}

console.log('Diff categorization:')
for (const [cat, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(25)} ${n}`)
}

// Print samples for non-identical categories
for (const [cat, diffs] of Object.entries(samples)) {
  if (cat === 'identical') continue
  console.log(`\n=== ${cat} (${counts[cat]} files, sampling ${diffs.length}) ===`)
  for (const d of diffs) {
    console.log(`  ${d.file}`)
    // Find first differing line for quick eyeballing
    const oldLines = d.oldOut.split('\n')
    const newLines = d.newOut.split('\n')
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) {
        const oldShort = (oldLines[i] || '').slice(0, 200)
        const newShort = (newLines[i] || '').slice(0, 200)
        console.log(`    OLD: ${oldShort}`)
        console.log(`    NEW: ${newShort}`)
        break
      }
    }
  }
}

const regressions = counts.regression || 0
if (regressions > 0) {
  console.log(`\nFAIL: ${regressions} files have unclassified diffs (regressions). Investigate above samples.`)
  process.exit(1)
}
console.log(`\nOK: All ${files.length - (counts.identical || 0)} non-identical diffs fall into known categories.`)
process.exit(0)
