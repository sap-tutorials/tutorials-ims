// scripts/lint-rules/directive-suggest-ui.ts
//
// Advisory lint rule: suggests :ui[...]{type=button} directive when author
// writes the old-style "click **X**" pattern.
//
// Fires on lines matching /click \*\*([^*]+)\*\*/i — i.e. the word "click"
// followed by bold text. Does NOT fire:
//   - when the line already contains :ui[ (author already migrated)
//   - when the line is inside a fenced code block (arrives as a blank line
//     per the lint-tutorial-markdown fence-redaction contract)
//
// Severity: 'notice' — purely advisory, does not block the build.

import type { LintFinding } from '../lint-tutorial-markdown.js'

const PATTERN = /click \*\*([^*]+)\*\*/gi

export const directiveSuggestUiRule = {
  id: 'directive-suggest-ui',
  describe: 'Suggests :ui[...]{type=button} directive in place of "click **X**" bold text.',
  scan(slug: string, lines: string[], rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Blank lines are fence-redacted content — skip
      if (!line) continue

      // Author already using :ui[ on this line — skip entirely
      if (line.includes(':ui[')) continue

      // Find all matches of the click **X** pattern on this line
      const matches = [...line.matchAll(PATTERN)]
      for (const match of matches) {
        const matched = match[0]        // full match, e.g. "click **Save**"
        const label = match[1]          // captured group, e.g. "Save"
        const lineNum = i + 1           // 1-based

        findings.push({
          rule: 'directive-suggest-ui',
          slug,
          file: `${slug}.md`,
          line: lineNum,
          message: `suggest :ui[${label}]{type=button} instead of **${label}** (line ${lineNum} in ${slug})`,
          excerpt: rawLines[i] ?? '',
          severity: 'notice',
        })
      }
    }

    return findings
  },
}
