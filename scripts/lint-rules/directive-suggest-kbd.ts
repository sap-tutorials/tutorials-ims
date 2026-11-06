// scripts/lint-rules/directive-suggest-kbd.ts
//
// Advisory lint rule: suggests :kbd[...] directive when author writes a
// keyboard shortcut using plain text (e.g. "Ctrl+S", "Cmd+Shift+P").
//
// Fires on lines matching /\b(Ctrl|Cmd|Command|Alt|Option|Shift|Win)\+\S+/i.
// Does NOT fire:
//   - when the line already contains :kbd[ (author already migrated)
//   - when the line is inside a fenced code block (arrives as a blank line
//     per the lint-tutorial-markdown fence-redaction contract)
//   - when the match appears after a URL separator (?, /, =, &) to avoid
//     false-positives on URLs with query parameters
//
// Severity: 'notice' — purely advisory, does not block the build.

import type { LintFinding } from '../lint-tutorial-markdown.js'

// Negative lookbehind on URL separators avoids matching query-string fragments
// like "?Shift+something" or "path/Win+32". The `\b` word boundary ensures we
// don't match mid-word (e.g. "unshift+1").
const PATTERN = /(?<![?/=&])\b(Ctrl|Cmd|Command|Alt|Option|Shift|Win)\+\S+/gi

export const directiveSuggestKbdRule = {
  id: 'directive-suggest-kbd',
  describe: 'Suggests :kbd[...] directive in place of plain-text keyboard shortcuts.',
  scan(slug: string, lines: string[], rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Blank lines are fence-redacted content — skip
      if (!line) continue

      // Author already using :kbd[ on this line — skip entirely
      if (line.includes(':kbd[')) continue

      // Find all keyboard shortcut matches on this line
      const matches = [...line.matchAll(PATTERN)]
      for (const match of matches) {
        const matched = match[0]  // full match, e.g. "Ctrl+S"
        const lineNum = i + 1     // 1-based

        findings.push({
          rule: 'directive-suggest-kbd',
          slug,
          file: `${slug}.md`,
          line: lineNum,
          message: `suggest :kbd[...] for keyboard shortcut "${matched}" (line ${lineNum} in ${slug})`,
          excerpt: rawLines[i] ?? '',
          severity: 'notice',
        })
      }
    }

    return findings
  },
}
