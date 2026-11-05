// scripts/lint-rules/directive-unknown.ts
//
// Warns when a tutorial markdown file contains an unregistered directive name.
// Unknown directive names are parsed by parseDirectives as warnings with code
// 'directive/unknown' and are left unchanged in the output (no node emitted).
//
// This lint rule converts those warnings into LintFindings with severity
// 'warning' so authors get explicit feedback at lint time. The build does NOT
// fail on unknown directives (they are safe to leave in the markdown) — only
// authors who check lint output will see the warning.
//
// Severity: warning (not error). Unknown directives might be false positives
// (e.g., prose that coincidentally looks like `:foo[bar]`), so we warn but
// do not block the build.

import { parseDirectives } from '../parsers/directives.js'
import type { LintFinding } from '../lint-tutorial-markdown.js'

export const directiveUnknownRule = {
  id: 'directive-unknown',
  describe: 'Unknown directive name — not registered in the directive registry.',
  scan(slug: string, lines: string[], _rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []
    const md = lines.join('\n')

    // Parse directives and collect warnings
    const { warnings } = parseDirectives(md, { slug })

    // Convert 'directive/unknown' warnings to LintFindings
    for (const warning of warnings) {
      if (warning.code === 'directive/unknown') {
        findings.push({
          rule: 'directive-unknown',
          slug,
          file: `${slug}.md`,
          line: warning.line,
          message: warning.message,
          excerpt: lines[warning.line - 1] ?? '',
          severity: 'warning',
        })
      }
    }

    return findings
  },
}
