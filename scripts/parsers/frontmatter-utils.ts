const ACRONYMS = new Set(['SAP', 'HANA', 'CAP', 'BTP', 'CDS', 'UI', 'API', 'MTA', 'XSUAA', 'OData', 'HTML5', 'ABAP'])

export type TagLabelRegistry = Record<string, string>

/**
 * Resolve a raw tag slug into a human label.
 *
 * If a `registry` is provided AND contains an entry for the raw slug, that
 * label is returned verbatim — this is the only way to recover information
 * the slug threw away (slashes, mid-word capitals, punctuation).
 *
 * Otherwise falls back to a lossy heuristic: take the segment after `>`,
 * split on `-`/`_`, title-case each word, promote known acronyms to all-caps.
 */
export function humanizeTag(raw: string, registry?: TagLabelRegistry): string {
  if (registry && registry[raw]) return registry[raw]
  const value = raw.includes('>') ? raw.split('>').pop()! : raw
  return value
    .replace(/\\/g, '')
    .replace(/[-_]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(word => {
      const upper = word.toUpperCase()
      if (ACRONYMS.has(upper)) return upper
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

/**
 * Clean the raw `## Prerequisites` section into a markdown string, preserving
 * its structure (paragraphs stay paragraphs, lists stay lists) so Hugo can
 * `markdownify` it exactly like a step body.
 *
 * The previous `splitPrerequisites` returned `string[]` (one entry per source
 * line, leading `- ` stripped), which forced the render paths to wrap every
 * line in `<li>`. That flat model could not represent prose, wrapped
 * multi-line paragraphs, or mixed prose+bullets — each rendered as malformed
 * bullets (one `<li>` per physical line). See issue #1388.
 *
 * Cleaning is deliberately minimal so markdown is preserved verbatim:
 * - Drop standalone thematic-break tokens (`---` horizontal rule). Source
 *   tutorials commonly close the Prerequisites section with a `---` before the
 *   first step, and `extractSection`'s lookahead (next `## ` / `### ` / EOF)
 *   captures it. Without this filter the `---` renders as a stray <hr> inside
 *   the prereq box (issue #163).
 * - Trim whitespace around the whole block.
 *
 * This helper does NOT sanitize HTML — it only cleans structure. The two emit
 * sites wrap the result in the SAME step-body sanitizer they apply to step
 * content (render-frontmatter.ts → stripDangerousHtml; fetch-tutorials.ts →
 * sanitizeStepContent), so the tag/attribute + iframe-host allowlists that the
 * rest of the tutorial pipeline enforces also apply here (issue #1388 review).
 */
export function cleanPrerequisites(prereqText: string): string {
  if (!prereqText) return ''
  return prereqText
    .split('\n')
    .filter(line => !/^\s*-{3,}\s*$/.test(line))
    .join('\n')
    .trim()
}
