/**
 * deprecated-cli lint rule: flags deprecated CLI commands in tutorial shell fences.
 *
 * Scans bash/sh/shell/console/terminal/powershell/cmd fences for commands
 * matching known deprecated patterns from cli-deprecations.json.
 */
import { createRequire } from 'node:module'
import type { LintFinding } from '../lint-tutorial-markdown.js'

const require = createRequire(import.meta.url)

interface CliDeprecation {
  tool: string
  match: string
  severity: 'warn' | 'error'
  since: string
  message: string
  replacement: string
  docs: string
}

const DEPRECATIONS: CliDeprecation[] = require('./data/cli-deprecations.json')

// Shell fence languages that trigger scanning (case-insensitive)
const SHELL_LANGS = /^(bash|sh|shell|console|terminal|powershell|cmd)$/i

// Prompt prefixes to strip before matching
const PROMPT_RE = /^(\$\s|PS>\s|>\s|#\s)/

type Rule = {
  id: string
  describe: string
  scan(slug: string, lines: string[], rawLines: string[]): LintFinding[]
}

export const deprecatedCliRule: Rule = {
  id: 'deprecated-cli',
  describe: 'Flags deprecated CLI commands in shell fences.',

  scan(slug: string, _lines: string[], rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []
    let inFence = false
    let fenceLang = ''

    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i]
      const lineNum = i + 1

      // Detect fence delimiter
      const fenceMatch = raw.match(/^[ \t]{0,3}(```|~~~)(\S*)/)
      if (fenceMatch) {
        if (!inFence) {
          inFence = true
          fenceLang = fenceMatch[2] ?? ''
        } else {
          inFence = false
          fenceLang = ''
        }
        continue
      }

      if (!inFence || !SHELL_LANGS.test(fenceLang)) continue

      // Strip prompt, then match against deprecation patterns
      const stripped = raw.replace(PROMPT_RE, '')

      for (const dep of DEPRECATIONS) {
        const re = new RegExp(dep.match)
        if (re.test(stripped)) {
          findings.push({
            rule: 'deprecated-cli',
            slug,
            file: `${slug}.md`,
            line: lineNum,
            message: `${dep.message} Replacement: ${dep.replacement} Docs: ${dep.docs}`,
            excerpt: raw.trim(),
            severity: 'warning',
          })
        }
      }
    }

    return findings
  },
}
