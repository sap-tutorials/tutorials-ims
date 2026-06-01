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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function splitPrerequisites(prereqText: string): string[] {
  if (!prereqText) return []
  return prereqText
    .split('\n')
    .map(line => line.replace(/^\s*-\s+/, '').trim())
    .map(line => escapeHtml(line))
    .filter(line => line.length > 0)
}
