/**
 * Authoring-aids lint rules.
 *
 * authorNotesInProdRule — warns when PROD source contains `%% … %%` author notes.
 * qaOnlyInProdRule      — warns when PROD source contains `:::qa-only` blocks.
 *
 * Both rules scan `rawLines` (not the fence-redacted `lines`) because author
 * notes could appear inside fence context — but PROD source must NOT contain
 * them regardless of location.
 */
import type { LintFinding } from '../lint-tutorial-markdown.js'

type Rule = {
  id: string
  describe: string
  scan(slug: string, lines: string[], rawLines: string[]): LintFinding[]
}

/** Returns the set of 0-based line indices that are inside a fenced code block. */
function fencedLineIndices(rawLines: string[]): Set<number> {
  const fenced = new Set<number>()
  let inFence = false
  for (let i = 0; i < rawLines.length; i++) {
    const fenceMatch = rawLines[i].match(/^[ \t]{0,3}(```|~~~)/)
    if (fenceMatch) {
      inFence = !inFence
      fenced.add(i) // delimiter line itself is also "fenced" (not note content)
      continue
    }
    if (inFence) fenced.add(i)
  }
  return fenced
}

export const authorNotesInProdRule: Rule = {
  id: 'author-notes-in-prod-source',
  describe: 'PROD source contains author notes (`%% … %%`). These are stripped at publish time but indicate the source was not cleaned before promotion.',

  scan(slug, _lines, rawLines): LintFinding[] {
    const findings: LintFinding[] = []
    const fenced = fencedLineIndices(rawLines)

    for (let i = 0; i < rawLines.length; i++) {
      if (fenced.has(i)) continue
      if (rawLines[i].includes('%%')) {
        findings.push({
          rule: 'author-notes-in-prod-source',
          slug,
          file: slug,
          line: i + 1,
          message: 'Author note (`%% … %%`) found in PROD source. Remove before promoting to PROD.',
          excerpt: rawLines[i].trim(),
          severity: 'warning',
        })
      }
    }
    return findings
  },
}

export const qaOnlyInProdRule: Rule = {
  id: 'qa-only-in-prod-source',
  describe: 'PROD source contains `:::qa-only` blocks. These are stripped at publish time but indicate the source was not cleaned before promotion.',

  scan(slug, _lines, rawLines): LintFinding[] {
    const findings: LintFinding[] = []

    for (let i = 0; i < rawLines.length; i++) {
      if (/^:::qa-only/.test(rawLines[i])) {
        findings.push({
          rule: 'qa-only-in-prod-source',
          slug,
          file: slug,
          line: i + 1,
          message: '`:::qa-only` block found in PROD source. Resolve or remove before promoting to PROD.',
          excerpt: rawLines[i].trim(),
          severity: 'warning',
        })
      }
    }
    return findings
  },
}
